import { randomBytes } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

type Queryable = Pick<Pool, 'query'> | Pick<PoolClient, 'query'>;
type TransactionClient = Pick<PoolClient, 'query'>;
export type DerivedMemoryRowKind = 'scene_summary' | 'registry_entry';
export type ReferenceCursor = {
  sessionId: string;
  rowKind: DerivedMemoryRowKind;
  rowId: string;
};
export type ReconciliationResult = {
  checkpoint: ReferenceCursor | null;
  processed: number;
  complete: boolean;
};
type DerivedRow = {
  session_id: string;
  row_kind: DerivedMemoryRowKind;
  row_id: string;
  body: string;
};

/**
 * Serialize derived-memory writes with session-hold creation and reject writes to held sessions.
 * The legal_holds trigger takes the matching session row FOR UPDATE before inserting/deleting a
 * session hold; writers take FOR SHARE and re-check the hold in this same transaction.
 */
export async function lockSessionForDerivedMemoryWrite(
  db: Queryable,
  sessionId: string,
): Promise<void> {
  await db.query('SELECT id FROM sessions WHERE id=$1 FOR SHARE', [sessionId]);
  const held = await db.query(
    "SELECT 1 FROM legal_holds WHERE kind='session' AND item_id=$1::uuid::text",
    [sessionId],
  );
  if (held.rowCount)
    throw new Error('Session is held; refusing derived memory mutation');
}

const isHeld = async (db: Queryable, sessionId: string): Promise<boolean> => {
  const held = await db.query(
    "SELECT 1 FROM legal_holds WHERE kind='session' AND item_id=$1::uuid::text",
    [sessionId],
  );
  return Boolean(held.rowCount);
};

/** Get/create a random, stable token for a character actively bound to this session. */
export async function ensureSessionCharacterToken(
  db: Queryable,
  sessionId: string,
  characterId: string,
): Promise<string> {
  if (
    !('release' in db) &&
    'connect' in db &&
    typeof db.connect === 'function'
  ) {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const token = await ensureSessionCharacterToken(
        client,
        sessionId,
        characterId,
      );
      await client.query('COMMIT');
      return token;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  await lockSessionForDerivedMemoryWrite(db, sessionId);
  const binding = await db.query(
    `SELECT 1 FROM session_seat_characters
    WHERE session_id=$1 AND character_id=$2 AND binding_status='active'`,
    [sessionId, characterId],
  );
  if (!binding.rowCount)
    throw new Error('Character has no active session seat binding');
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const candidate = randomBytes(24).toString('base64url');
    await db.query('SAVEPOINT token_candidate');
    try {
      const { rows } = await db.query<{ token: string }>(
        `INSERT INTO session_character_tokens(session_id, character_id, token) VALUES ($1,$2,$3)
         ON CONFLICT (session_id, character_id) DO UPDATE SET character_id=EXCLUDED.character_id RETURNING token`,
        [sessionId, characterId, candidate],
      );
      await db.query('RELEASE SAVEPOINT token_candidate');
      if (rows[0]?.token) return rows[0].token;
    } catch (error) {
      if ((error as { code?: string }).code !== '23505') throw error;
      await db.query('ROLLBACK TO SAVEPOINT token_candidate');
      await db.query('RELEASE SAVEPOINT token_candidate');
    }
  }
  throw new Error('Unable to allocate a unique character reference token');
}

/** Record exact character references in the caller's transaction. */
export async function indexDerivedMemoryRow(
  db: TransactionClient,
  sessionId: string,
  rowKind: DerivedMemoryRowKind,
  rowId: string | number,
  characterIds: readonly string[],
): Promise<void> {
  await lockSessionForDerivedMemoryWrite(db, sessionId);
  const ids = [...new Set(characterIds)];
  for (const characterId of ids) {
    await db.query(
      `INSERT INTO derived_memory_character_refs(session_id,character_id,row_kind,row_id)
      SELECT $1,$2,$3,$4 WHERE EXISTS (SELECT 1 FROM session_character_tokens WHERE session_id=$1 AND character_id=$2)
      ON CONFLICT DO NOTHING`,
      [sessionId, characterId, rowKind, rowId],
    );
    const check = await db.query(
      `SELECT 1 FROM derived_memory_character_refs WHERE session_id=$1 AND character_id=$2 AND row_kind=$3 AND row_id=$4`,
      [sessionId, characterId, rowKind, rowId],
    );
    if (!check.rowCount)
      throw new Error(
        'Character reference mapping is missing; refusing unindexed write',
      );
  }
}

function afterCursor(row: DerivedRow, cursor: ReferenceCursor | null): boolean {
  if (!cursor) return true;
  return (
    row.session_id > cursor.sessionId ||
    (row.session_id === cursor.sessionId &&
      ((row.row_kind === 'registry_entry' &&
        cursor.rowKind === 'scene_summary') ||
        (row.row_kind === cursor.rowKind &&
          BigInt(row.row_id) > BigInt(cursor.rowId))))
  );
}
// Tokens are 24 CSPRNG bytes (192 bits); substring false positives are negligible.
function containsStoredToken(body: string, token: string): boolean {
  return body.includes(token);
}

/** Bounded keyset reconciliation. Per-table keyset queries use session/id indexes; no full UNION scan. */
export async function reconcileDerivedMemoryCharacterRefs(
  pool: Pool,
  checkpoint: ReferenceCursor | null = null,
  batchSize = 100,
  onlySessionId?: string,
): Promise<ReconciliationResult> {
  const limit = Math.max(1, Math.min(500, Math.floor(batchSize)));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const state = await client.query<{
      complete: boolean;
      checkpoint_session_id: string | null;
      checkpoint_row_kind: DerivedMemoryRowKind | null;
      checkpoint_row_id: string | null;
    }>(
      'SELECT complete,checkpoint_session_id,checkpoint_row_kind,checkpoint_row_id FROM derived_memory_reconciliation_state WHERE singleton=true FOR UPDATE',
    );
    if (!state.rows[0])
      throw new Error(
        'Reconciliation state is missing; refusing coverage update',
      );
    let effectiveCheckpoint = checkpoint;
    if (onlySessionId) {
      const skipped = await client.query<{
        checkpoint_row_kind: DerivedMemoryRowKind | null;
        checkpoint_row_id: string | null;
      }>(
        'SELECT checkpoint_row_kind,checkpoint_row_id FROM derived_memory_reconcile_skipped WHERE session_id=$1 FOR UPDATE',
        [onlySessionId],
      );
      if (!skipped.rows[0]) {
        await client.query('COMMIT');
        return { checkpoint: null, processed: 0, complete: true };
      }
      const sessionLock = await client.query(
        'SELECT id FROM sessions WHERE id=$1 FOR SHARE',
        [onlySessionId],
      );
      if (!sessionLock.rowCount) {
        await client.query(
          'DELETE FROM derived_memory_reconcile_skipped WHERE session_id=$1',
          [onlySessionId],
        );
        await client.query('COMMIT');
        return { checkpoint: null, processed: 0, complete: true };
      }
      if (await isHeld(client, onlySessionId)) {
        await client.query(
          'UPDATE derived_memory_reconcile_skipped SET checkpoint_row_kind=NULL,checkpoint_row_id=NULL WHERE session_id=$1',
          [onlySessionId],
        );
        await client.query('COMMIT');
        return { checkpoint: null, processed: 0, complete: false };
      }
      effectiveCheckpoint =
        skipped.rows[0].checkpoint_row_kind && skipped.rows[0].checkpoint_row_id
          ? {
              sessionId: onlySessionId,
              rowKind: skipped.rows[0].checkpoint_row_kind,
              rowId: skipped.rows[0].checkpoint_row_id,
            }
          : null;
    } else if (checkpoint) {
      const stored = state.rows[0];
      if (
        stored.checkpoint_session_id !== checkpoint.sessionId ||
        stored.checkpoint_row_kind !== checkpoint.rowKind ||
        stored.checkpoint_row_id !== checkpoint.rowId
      )
        throw new Error(
          'Reconciliation checkpoint does not match durable state',
        );
    } else {
      await client.query(
        'UPDATE derived_memory_reconciliation_state SET complete=false,checkpoint_session_id=NULL,checkpoint_row_kind=NULL,checkpoint_row_id=NULL WHERE singleton=true',
      );
    }
    const cursor = effectiveCheckpoint;
    const [summaries, entries] = await Promise.all([
      client.query<{ session_id: string; row_id: string; body: string }>(
        `SELECT session_id,id AS row_id,summary AS body FROM scene_summaries WHERE ($5::uuid IS NULL OR session_id=$5) AND ($1::uuid IS NULL OR (session_id,id) > ($1::uuid, CASE WHEN $2='scene_summary' THEN $3::bigint ELSE 9223372036854775807::bigint END)) ORDER BY session_id,id LIMIT $4`,
        [
          cursor?.sessionId ?? null,
          cursor?.rowKind ?? null,
          cursor?.rowId ?? null,
          limit,
          onlySessionId ?? null,
        ],
      ),
      client.query<{ session_id: string; row_id: string; body: string }>(
        `SELECT e.session_id,e.id AS row_id,concat_ws(' ',e.name,array_to_string(e.aliases,' '),e.payload::text,e.search_document,(SELECT string_agg(f.fact,' ') FROM registry_facts f WHERE f.entry_id=e.id)) AS body FROM registry_entries e WHERE ($5::uuid IS NULL OR e.session_id=$5) AND ($1::uuid IS NULL OR (e.session_id,e.id) > ($1::uuid, CASE WHEN $2='scene_summary' THEN 0::bigint ELSE $3::bigint END)) ORDER BY e.session_id,e.id LIMIT $4`,
        [
          cursor?.sessionId ?? null,
          cursor?.rowKind ?? null,
          cursor?.rowId ?? null,
          limit,
          onlySessionId ?? null,
        ],
      ),
    ]);
    const candidates: DerivedRow[] = [
      ...summaries.rows.map((r) => ({
        session_id: r.session_id,
        row_kind: 'scene_summary' as const,
        row_id: r.row_id,
        body: r.body,
      })),
      ...entries.rows.map((r) => ({
        session_id: r.session_id,
        row_kind: 'registry_entry' as const,
        row_id: r.row_id,
        body: r.body,
      })),
    ]
      .filter((row) => afterCursor(row, cursor))
      .sort(
        (a, b) =>
          a.session_id.localeCompare(b.session_id) ||
          (a.row_kind === b.row_kind
            ? 0
            : a.row_kind === 'scene_summary'
              ? -1
              : 1) ||
          (BigInt(a.row_id) < BigInt(b.row_id)
            ? -1
            : BigInt(a.row_id) > BigInt(b.row_id)
              ? 1
              : 0),
      )
      .slice(0, limit);
    const candidateSessionIds = [
      ...new Set(candidates.map((row) => row.session_id)),
    ];
    const storedTokenResult = candidateSessionIds.length
      ? await client.query<{
          session_id: string;
          character_id: string;
          token: string;
        }>(
          'SELECT session_id,character_id,token FROM session_character_tokens WHERE session_id=ANY($1::uuid[])',
          [candidateSessionIds],
        )
      : { rows: [] };
    const tokensBySession = new Map<string, typeof storedTokenResult.rows>();
    for (const stored of storedTokenResult.rows) {
      const sessionTokens = tokensBySession.get(stored.session_id) ?? [];
      sessionTokens.push(stored);
      tokensBySession.set(stored.session_id, sessionTokens);
    }
    for (const row of candidates) {
      const sessionLock = await client.query(
        'SELECT id FROM sessions WHERE id=$1 FOR SHARE',
        [row.session_id],
      );
      if (!sessionLock.rowCount) continue;
      if (await isHeld(client, row.session_id)) {
        await client.query(
          'INSERT INTO derived_memory_reconcile_skipped(session_id) VALUES($1) ON CONFLICT(session_id) DO NOTHING',
          [row.session_id],
        );
        continue;
      }
      const matchingCharacterIds = (tokensBySession.get(row.session_id) ?? [])
        .filter(({ token }) => containsStoredToken(row.body, token))
        .map(({ character_id }) => character_id);
      if (matchingCharacterIds.length)
        await client.query(
          `INSERT INTO derived_memory_character_refs(session_id,character_id,row_kind,row_id)
        SELECT $1,character_id,$2,$3 FROM unnest($4::uuid[]) AS matches(character_id) ON CONFLICT DO NOTHING`,
          [row.session_id, row.row_kind, row.row_id, matchingCharacterIds],
        );
    }
    const last = candidates.at(-1);
    const complete = candidates.length < limit;
    const next = last
      ? {
          sessionId: last.session_id,
          rowKind: last.row_kind,
          rowId: last.row_id,
        }
      : cursor;
    if (onlySessionId) {
      if (complete) {
        await client.query(
          'DELETE FROM derived_memory_reconcile_skipped WHERE session_id=$1',
          [onlySessionId],
        );
      } else if (last) {
        await client.query(
          'UPDATE derived_memory_reconcile_skipped SET checkpoint_row_kind=$2,checkpoint_row_id=$3 WHERE session_id=$1',
          [onlySessionId, last.row_kind, last.row_id],
        );
      }
    } else {
      await client.query(
        'UPDATE derived_memory_reconciliation_state SET complete=$1,checkpoint_session_id=$2,checkpoint_row_kind=$3,checkpoint_row_id=$4 WHERE singleton=true',
        [
          complete,
          next?.sessionId ?? null,
          next?.rowKind ?? null,
          next?.rowId ?? null,
        ],
      );
    }
    await client.query('COMMIT');
    return {
      checkpoint: last
        ? {
            sessionId: last.session_id,
            rowKind: last.row_kind,
            rowId: last.row_id,
          }
        : cursor,
      processed: candidates.length,
      complete,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** Coverage is derived from the durable reconciliation state and exact per-character row comparison. */
export async function getIndexedDerivedMemoryRows(
  db: Queryable,
  sessionId: string,
  characterId: string,
): Promise<Array<{ rowKind: DerivedMemoryRowKind; rowId: string }>> {
  const state = await db.query<{ complete: boolean }>(
    'SELECT complete FROM derived_memory_reconciliation_state WHERE singleton=true',
  );
  if (!state.rows[0]?.complete)
    throw new Error('Reference-index coverage is unverified; defer deletion');
  const skipped = await db.query(
    'SELECT 1 FROM derived_memory_reconcile_skipped WHERE session_id=$1',
    [sessionId],
  );
  if (skipped.rowCount)
    throw new Error('Reference-index coverage is unverified; defer deletion');
  if (await isHeld(db, sessionId))
    throw new Error('Session is held; refusing indexed lookup');
  const { rows: tokens } = await db.query<{ token: string }>(
    'SELECT token FROM session_character_tokens WHERE session_id=$1 AND character_id=$2',
    [sessionId, characterId],
  );
  const eligible: DerivedRow[] = [];
  const summaries = await db.query<{ id: string; summary: string }>(
    'SELECT id,summary FROM scene_summaries WHERE session_id=$1',
    [sessionId],
  );
  eligible.push(
    ...summaries.rows.map((r) => ({
      session_id: sessionId,
      row_kind: 'scene_summary' as const,
      row_id: r.id,
      body: r.summary,
    })),
  );
  const entries = await db.query<{ id: string; body: string }>(
    `SELECT e.id,concat_ws(' ',e.name,array_to_string(e.aliases,' '),e.payload::text,e.search_document,(SELECT string_agg(f.fact,' ') FROM registry_facts f WHERE f.entry_id=e.id)) AS body FROM registry_entries e WHERE e.session_id=$1`,
    [sessionId],
  );
  eligible.push(
    ...entries.rows.map((r) => ({
      session_id: sessionId,
      row_kind: 'registry_entry' as const,
      row_id: r.id,
      body: r.body,
    })),
  );
  const expected = new Set<string>();
  for (const row of eligible)
    if (tokens.some((t) => containsStoredToken(row.body, t.token)))
      expected.add(`${row.row_kind}:${row.row_id}`);
  const { rows: refs } = await db.query<{
    row_kind: DerivedMemoryRowKind;
    row_id: string;
  }>(
    'SELECT row_kind,row_id FROM derived_memory_character_refs WHERE session_id=$1 AND character_id=$2',
    [sessionId, characterId],
  );
  const actual = new Set(refs.map((r) => `${r.row_kind}:${r.row_id}`));
  if (
    expected.size !== actual.size ||
    [...expected].some((key) => !actual.has(key))
  )
    throw new Error('Reference-index coverage is incomplete; defer deletion');
  return refs.map(({ row_kind, row_id }) => ({
    rowKind: row_kind,
    rowId: row_id,
  }));
}
