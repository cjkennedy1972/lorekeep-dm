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
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,}$/;

/** Get/create a random, stable token. The unique constraint retries races/collisions safely. */
export async function ensureSessionCharacterToken(
  db: Queryable,
  sessionId: string,
  characterId: string,
): Promise<string> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const candidate = randomBytes(24).toString('base64url');
    try {
      const { rows } = await db.query<{ token: string }>(
        `INSERT INTO session_character_tokens(session_id, character_id, token)
         VALUES ($1, $2, $3)
         ON CONFLICT (session_id, character_id) DO UPDATE
           SET character_id = EXCLUDED.character_id
         RETURNING token`,
        [sessionId, characterId, candidate],
      );
      if (rows[0]?.token) return rows[0].token;
    } catch (error) {
      if ((error as { code?: string }).code !== '23505') throw error;
    }
  }
  throw new Error('Unable to allocate a unique character reference token');
}

/** Record the exact character references for a derived row in its caller's transaction. */
export async function indexDerivedMemoryRow(
  db: TransactionClient,
  sessionId: string,
  rowKind: DerivedMemoryRowKind,
  rowId: string | number,
  characterIds: readonly string[],
): Promise<void> {
  const ids = [...new Set(characterIds)];
  for (const characterId of ids) {
    await db.query(
      `INSERT INTO derived_memory_character_refs(session_id, character_id, row_kind, row_id)
       SELECT $1, $2, $3, $4
        WHERE EXISTS (SELECT 1 FROM session_character_tokens
                       WHERE session_id=$1 AND character_id=$2)
       ON CONFLICT DO NOTHING`,
      [sessionId, characterId, rowKind, rowId],
    );
    const check = await db.query(
      `SELECT 1 FROM derived_memory_character_refs
        WHERE session_id=$1 AND character_id=$2 AND row_kind=$3 AND row_id=$4`,
      [sessionId, characterId, rowKind, rowId],
    );
    if (!check.rowCount)
      throw new Error(
        'Character reference mapping is missing; refusing unindexed write',
      );
  }
}

/**
 * Reconcile explicit opaque tokens in persisted rows. No names or substring guesses
 * are used. The returned cursor is a durable checkpoint for the caller to store.
 * Each batch commits independently; invoking again from the last cursor is safe.
 */
export async function reconcileDerivedMemoryCharacterRefs(
  pool: Pool,
  checkpoint: ReferenceCursor | null = null,
  batchSize = 100,
): Promise<ReconciliationResult> {
  const limit = Math.max(1, Math.min(500, Math.floor(batchSize)));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const rows = await client.query<{
      session_id: string;
      row_kind: DerivedMemoryRowKind;
      row_id: string;
      body: string;
    }>(
      `SELECT session_id, row_kind, row_id, body FROM (
         SELECT session_id, 'scene_summary'::text AS row_kind, id AS row_id, summary AS body
           FROM scene_summaries
         UNION ALL
         SELECT entry.session_id, 'registry_entry'::text, entry.id, concat_ws(' ', entry.name,
                array_to_string(entry.aliases, ' '), entry.payload::text, entry.search_document,
                (SELECT string_agg(fact.fact, ' ') FROM registry_facts fact WHERE fact.entry_id=entry.id))
           FROM registry_entries entry
       ) derived
       WHERE ($1::uuid IS NULL OR (session_id, row_kind, row_id) > ($1::uuid, $2::text, $3::bigint))
       ORDER BY session_id, row_kind, row_id LIMIT $4`,
      [
        checkpoint?.sessionId ?? null,
        checkpoint?.rowKind ?? null,
        checkpoint?.rowId ?? null,
        limit,
      ],
    );
    for (const row of rows.rows) {
      const candidates = [
        ...new Set(row.body.match(/[A-Za-z0-9_-]{32,}/g) ?? []),
      ].filter((candidate) => TOKEN_PATTERN.test(candidate));
      if (candidates.length) {
        await client.query(
          `INSERT INTO derived_memory_character_refs(session_id, character_id, row_kind, row_id)
           SELECT $1, token.character_id, $2, $3
             FROM session_character_tokens token
            WHERE token.session_id=$1 AND token.token = ANY($4::text[])
           ON CONFLICT DO NOTHING`,
          [row.session_id, row.row_kind, row.row_id, candidates],
        );
      }
    }
    await client.query('COMMIT');
    const last = rows.rows.at(-1);
    return {
      checkpoint: last
        ? {
            sessionId: last.session_id,
            rowKind: last.row_kind,
            rowId: last.row_id,
          }
        : checkpoint,
      processed: rows.rowCount ?? rows.rows.length,
      complete: rows.rows.length < limit,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** Character deletion may proceed only when reconciliation has been marked complete by its caller. */
export async function getIndexedDerivedMemoryRows(
  db: Queryable,
  sessionId: string,
  characterId: string,
  coverageVerified: boolean,
): Promise<Array<{ rowKind: DerivedMemoryRowKind; rowId: string }>> {
  if (!coverageVerified)
    throw new Error('Reference-index coverage is unverified; defer deletion');
  const { rows } = await db.query<{
    row_kind: DerivedMemoryRowKind;
    row_id: string;
  }>(
    `SELECT row_kind, row_id FROM derived_memory_character_refs
      WHERE session_id=$1 AND character_id=$2 ORDER BY row_kind, row_id`,
    [sessionId, characterId],
  );
  return rows.map(({ row_kind, row_id }) => ({
    rowKind: row_kind,
    rowId: row_id,
  }));
}
