import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { removeArchive } from './exports.js';
import { skipIfHeld, type JobContext } from '../types.js';
import { advanceTurn, settle } from '../../room/combatEngine.js';
import type { RoomCombatState } from '../../room/combatTypes.js';

const ANON_NAME = 'Deleted player';
const PLAYER_TEXT_KEYS = ['playerName', 'text', 'narrative'];
const HELD = 'HELD';

interface Scrub {
  accountId: string;
  placeholder: string;
  charPlaceholder: string;
  charIds: Set<string>;
}

interface EventRow {
  session_id: string;
  seq: string;
  payload: unknown;
}

interface SnapshotRow {
  session_id: string;
  seq: string;
  state: unknown;
}

const FENCE_NODE = 'retention:accountDeletion';

/**
 * Coordinates with live Rooms the way Persistence.transaction does: lock the session row,
 * then take its lease (bumping the epoch). A live lease means a Room may hold unsaved
 * state, so fail closed (HELD: the account stays 'deleting', retried next sweep).
 * Once we commit, the lease is released but the epoch has moved, so a stale Room's commit
 * fails its fence and the Room reloads from the scrubbed snapshot.
 */
async function fenceSession(
  ctx: JobContext,
  client: PoolClient,
  fenced: Set<string>,
  sessionId: string,
) {
  if (fenced.has(sessionId)) return;
  if (await skipIfHeld(ctx, 'accountDeletion', 'session', sessionId))
    throw new Error(HELD);
  await client.query('SELECT id FROM sessions WHERE id=$1 FOR UPDATE', [
    sessionId,
  ]);
  const lease = await client.query(
    `INSERT INTO session_lease(session_id,node_id,expires_at,epoch)
     VALUES ($1,$2,clock_timestamp() + interval '5 minutes',1)
     ON CONFLICT (session_id) DO UPDATE SET
       node_id = EXCLUDED.node_id, expires_at = EXCLUDED.expires_at, epoch = session_lease.epoch + 1
     WHERE session_lease.expires_at <= clock_timestamp()
     RETURNING epoch`,
    [sessionId, FENCE_NODE],
  );
  if (!lease.rowCount) throw new Error(HELD);
  fenced.add(sessionId);
}

/**
 * ADR-017 account deletion: purge exports, hand off or delete owned rooms, then
 * scrub the account from every surviving room (events via redact_event, snapshots
 * via UPDATE), and finally hard-delete the accounts row (cascades tokens, auth
 * sessions, tickets, jobs).
 *
 * Heir handoff: an owned room passes to another seated active account. The deleted
 * player's character sheet is cleared, and their account id, character id, and
 * player-typed text are removed everywhere. The heir keeps their own characters and
 * shared room state; the export whitelist never exposes other seats.
 */
async function deleteAccount(
  ctx: JobContext,
  client: PoolClient,
  accountId: string,
) {
  const fenced = new Set<string>();
  const counts = {
    exports: 0,
    roomsDeleted: 0,
    roomsHandedOff: 0,
    eventsScrubbed: 0,
    snapshotsScrubbed: 0,
  };
  const exportRows = (
    await client.query<{ id: string; archive_key: string | null }>(
      'SELECT id, archive_key FROM export_jobs WHERE account_id=$1',
      [accountId],
    )
  ).rows;
  for (const r of exportRows)
    if (await skipIfHeld(ctx, 'accountDeletion', 'export', r.id))
      throw new Error(HELD);
  for (const r of exportRows) await removeArchive(ctx, r.archive_key);
  counts.exports = exportRows.length;

  const owned = (
    await client.query<{ id: string; character_id: string | null }>(
      'SELECT id, character_id FROM sessions WHERE owner_account_id=$1',
      [accountId],
    )
  ).rows;
  const charIds = new Set<string>();
  for (const { id, character_id } of owned) {
    await fenceSession(ctx, client, fenced, id);
    if (character_id) charIds.add(character_id);
    const heir = (
      await client.query<{ account_id: string }>(
        `SELECT DISTINCT e.payload->>'accountId' AS account_id FROM events e
          JOIN accounts a ON a.id::text = e.payload->>'accountId' AND a.status='active'
          WHERE e.session_id=$1 AND e.type='SeatJoined' AND e.payload->>'accountId' <> $2 LIMIT 1`,
        [id, accountId],
      )
    ).rows[0];
    if (heir) {
      await client.query(
        'UPDATE sessions SET owner_account_id=$2, character=NULL, character_id=NULL WHERE id=$1',
        [id, heir.account_id],
      );
      counts.roomsHandedOff++;
    } else {
      const coSeats = (
        await client.query<{ account_id: string }>(
          `SELECT DISTINCT payload->>'accountId' AS account_id FROM events
            WHERE session_id=$1 AND type='SeatJoined'
              AND payload->>'accountId' IS NOT NULL AND payload->>'accountId' <> $2`,
          [id, accountId],
        )
      ).rows;
      for (const { account_id } of coSeats)
        if (await skipIfHeld(ctx, 'accountDeletion', 'account', account_id))
          throw new Error(HELD);
      await client.query('SELECT purge_session($1)', [id]);
      counts.roomsDeleted++;
    }
  }

  const accountPattern = `%${accountId}%`;
  // Fence every session that mentions the account before reading its rows, so a live
  // Room cannot commit between our read and our write.
  const mentioning = await client.query<{ session_id: string }>(
    `SELECT session_id FROM events WHERE payload::text LIKE $1
     UNION SELECT session_id FROM snapshots WHERE state::text LIKE $1`,
    [accountPattern],
  );
  for (const { session_id } of mentioning.rows.sort((a, b) =>
    a.session_id.localeCompare(b.session_id),
  ))
    await fenceSession(ctx, client, fenced, session_id);
  const eventRows = (
    await client.query<EventRow>(
      'SELECT session_id, seq, payload FROM events WHERE payload::text LIKE $1',
      [accountPattern],
    )
  ).rows;
  const snapshotRows = (
    await client.query<SnapshotRow>(
      'SELECT session_id, seq, state FROM snapshots WHERE state::text LIKE $1',
      [accountPattern],
    )
  ).rows;
  for (const row of eventRows) collectCharIds(row.payload, accountId, charIds);
  for (const row of snapshotRows) collectCharIds(row.state, accountId, charIds);

  if (charIds.size) {
    const charPatterns = [...charIds].map((id) => `%${id}%`);
    eventRows.push(
      ...(
        await client.query<EventRow>(
          'SELECT session_id, seq, payload FROM events WHERE payload::text LIKE ANY($1)',
          [charPatterns],
        )
      ).rows,
    );
    snapshotRows.push(
      ...(
        await client.query<SnapshotRow>(
          'SELECT session_id, seq, state FROM snapshots WHERE state::text LIKE ANY($1)',
          [charPatterns],
        )
      ).rows,
    );
  }

  const touched = [
    ...new Set([
      ...eventRows.map((row) => row.session_id),
      ...snapshotRows.map((row) => row.session_id),
    ]),
  ];
  for (const id of touched) {
    await fenceSession(ctx, client, fenced, id);
  }
  if (touched.length) {
    eventRows.push(
      ...(
        await client.query<EventRow>(
          "SELECT session_id, seq, payload FROM events WHERE session_id = ANY($1) AND payload::text LIKE '%lastPlayerText%'",
          [touched],
        )
      ).rows,
    );
    snapshotRows.push(
      ...(
        await client.query<SnapshotRow>(
          "SELECT session_id, seq, state FROM snapshots WHERE session_id = ANY($1) AND state::text LIKE '%lastPlayerText%'",
          [touched],
        )
      ).rows,
    );
  }

  const placeholders = new Map<string, string>();
  const placeholderFor = async (sessionId: string) => {
    let placeholder = placeholders.get(sessionId);
    if (!placeholder) {
      const seat = (
        await client.query<{ seat_id: string | null }>(
          `SELECT payload->>'seatId' AS seat_id FROM events
            WHERE session_id=$1 AND type='SeatJoined' AND payload->>'accountId'=$2 LIMIT 1`,
          [sessionId, accountId],
        )
      ).rows[0];
      placeholder = seat?.seat_id ?? randomUUID();
      placeholders.set(sessionId, placeholder);
    }
    return placeholder;
  };

  const charPlaceholder = randomUUID();
  const seenEvents = new Set<string>();
  for (const row of eventRows) {
    const key = `${row.session_id}:${row.seq}`;
    if (seenEvents.has(key)) continue;
    seenEvents.add(key);
    const payload = row.payload as Record<string, unknown>;
    const scrubbed = scrub(payload, {
      accountId,
      placeholder: await placeholderFor(row.session_id),
      charPlaceholder,
      charIds,
    });
    if (JSON.stringify(scrubbed) === JSON.stringify(payload)) continue;
    await client.query('SELECT redact_event($1,$2,$3)', [
      row.session_id,
      row.seq,
      scrubbed,
    ]);
    counts.eventsScrubbed++;
  }

  const seenSnapshots = new Set<string>();
  for (const row of snapshotRows) {
    const key = `${row.session_id}:${row.seq}`;
    if (seenSnapshots.has(key)) continue;
    seenSnapshots.add(key);
    const scrubbed = scrub(row.state, {
      accountId,
      placeholder: await placeholderFor(row.session_id),
      charPlaceholder,
      charIds,
    });
    if (JSON.stringify(scrubbed) === JSON.stringify(row.state)) continue;
    await client.query(
      'UPDATE snapshots SET state=$3 WHERE session_id=$1 AND seq=$2',
      [row.session_id, row.seq, scrubbed],
    );
    counts.snapshotsScrubbed++;
  }

  const needles = new Set<string>();
  for (const row of eventRows) collectScrubNeedles(row.payload, accountId, charIds, needles);
  for (const row of snapshotRows) collectScrubNeedles(row.state, accountId, charIds, needles);
  await scrubDerived(
    client,
    touched,
    [...needles].filter((n) => n.length >= MIN_NEEDLE).sort((a, b) => b.length - a.length),
  );

  if (charIds.size) {
    await client.query(
      'UPDATE sessions SET character=NULL, character_id=NULL WHERE character_id = ANY($1)',
      [[...charIds]],
    );
  }
  await client.query(
    'UPDATE operator_endpoint_audit SET actor_id=NULL WHERE actor_id=$1',
    [accountId],
  );
  await client.query(
    "UPDATE session_lease SET node_id='', expires_at=clock_timestamp() WHERE session_id = ANY($1) AND node_id=$2",
    [[...fenced], FENCE_NODE],
  );
  await client.query('DELETE FROM accounts WHERE id=$1', [accountId]);
  return counts;
}

const MIN_NEEDLE = 3;
const DERIVED_PLACEHOLDER = '[redacted]';

// ponytail: exact-string match only; LLM paraphrases of typed text in derived rows survive.
function collectScrubNeedles(
  value: unknown,
  accountId: string,
  charIds: Set<string>,
  out: Set<string>,
) {
  if (Array.isArray(value)) {
    for (const item of value) collectScrubNeedles(item, accountId, charIds, out);
    return;
  }
  if (!value || typeof value !== 'object') return;
  const obj = value as Record<string, unknown>;
  const owned = Object.values(obj).some(
    (v) => v === accountId || (typeof v === 'string' && charIds.has(v)),
  );
  for (const [key, child] of Object.entries(obj)) {
    if (typeof child === 'string') {
      if (key === 'lastPlayerText' || (owned && ['text', 'playerName', 'name'].includes(key)))
        out.add(child);
    }
    collectScrubNeedles(child, accountId, charIds, out);
  }
}

function redactText(text: string, needles: readonly string[]) {
  let out = text;
  for (const needle of needles) out = out.split(needle).join(DERIVED_PLACEHOLDER);
  return out;
}

function redactDeep(value: unknown, needles: readonly string[]): unknown {
  if (typeof value === 'string') return redactText(value, needles);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, needles));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, redactDeep(v, needles)]),
    );
  return value;
}

async function scrubDerived(
  client: PoolClient,
  sessionIds: string[],
  needles: readonly string[],
) {
  if (!sessionIds.length || !needles.length) return;
  const summaries = await client.query<{ id: string; summary: string }>(
    'SELECT id, summary FROM scene_summaries WHERE session_id = ANY($1)',
    [sessionIds],
  );
  for (const row of summaries.rows) {
    const summary = redactText(row.summary, needles);
    if (summary !== row.summary)
      await client.query('UPDATE scene_summaries SET summary=$2 WHERE id=$1', [
        row.id,
        summary,
      ]);
  }
  const entries = await client.query<{
    id: string;
    name: string;
    aliases: string[];
    payload: unknown;
    search_document: string;
  }>(
    'SELECT id, name, aliases, payload, search_document FROM registry_entries WHERE session_id = ANY($1)',
    [sessionIds],
  );
  for (const row of entries.rows) {
    const name = redactText(row.name, needles);
    const aliases = row.aliases.map((a) => redactText(a, needles));
    const payload = redactDeep(row.payload, needles);
    const searchDocument = redactText(row.search_document, needles);
    if (
      name === row.name &&
      JSON.stringify(aliases) === JSON.stringify(row.aliases) &&
      JSON.stringify(payload) === JSON.stringify(row.payload) &&
      searchDocument === row.search_document
    )
      continue;
    await client.query(
      'UPDATE registry_entries SET name=$2, aliases=$3, payload=$4, search_document=$5 WHERE id=$1',
      [row.id, name, aliases, payload, searchDocument],
    );
  }
  const facts = await client.query<{ id: string; fact: string }>(
    `SELECT f.id, f.fact FROM registry_facts f
      JOIN registry_entries e ON e.id = f.entry_id
      WHERE e.session_id = ANY($1)`,
    [sessionIds],
  );
  for (const row of facts.rows) {
    const fact = redactText(row.fact, needles);
    if (fact !== row.fact)
      await client.query('UPDATE registry_facts SET fact=$2 WHERE id=$1', [row.id, fact]);
  }
}

function collectCharIds(value: unknown, accountId: string, out: Set<string>) {
  if (Array.isArray(value)) {
    for (const item of value) collectCharIds(item, accountId, out);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    const id = (child as { id?: unknown } | null)?.id;
    if (key === accountId && typeof id === 'string') out.add(id);
    collectCharIds(child, accountId, out);
  }
}

function scrub(value: unknown, s: Scrub): unknown {
  if (typeof value === 'string') {
    if (value === s.accountId) return s.placeholder;
    return s.charIds.has(value) ? s.charPlaceholder : value;
  }
  if (Array.isArray(value))
    return value
      .filter((item) => !isDeletedCharacterRef(item, s.charIds))
      .map((item) => scrub(item, s));
  if (!isRecord(value)) return value;
  let obj = value;
  if (isRecord(obj.combatRoom))
    obj = {
      ...obj,
      combatRoom: pruneCombat(obj.combatRoom as RoomCombatState, s.charIds),
    };
  if (isRecord(obj.openClarifications))
    obj = {
      ...obj,
      openClarifications: Object.fromEntries(
        Object.entries(obj.openClarifications).filter(
          ([, c]) => !(isRecord(c) && c.accountId === s.accountId),
        ),
      ),
    };
  const owned = obj.accountId === s.accountId;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(obj)) {
    if (key === s.accountId || s.charIds.has(key)) continue;
    if (key === 'lastPlayerText') continue;
    if (owned && PLAYER_TEXT_KEYS.includes(key)) continue;
    out[key] = scrub(child, s);
  }
  if (owned) {
    out.accountId = s.placeholder;
    if ('displayName' in obj) {
      out.displayName = ANON_NAME;
      out.anonymized = true;
    }
  }
  return out;
}

/**
 * Drops the deleted character's entity and initiative slot. Pure and deterministic, so an
 * event payload and its snapshot scrub to the same state; it never runs monsters (their
 * events would be lost). If the deleted character held the turn, the turn passes to the
 * next living party member (monsters in between forfeit that stretch, nothing in the
 * engine resumes a monster turn on load). With no party left combat is ended.
 */
function pruneCombat(
  room: RoomCombatState,
  charIds: Set<string>,
): RoomCombatState {
  const up = (e: RoomCombatState['entities'][number]) =>
    e.team === 'party' && e.hp > 0 && !e.fled && !charIds.has(e.id);
  let state = room;
  if (!state.ended && charIds.has(state.combat.activeEntityId ?? '')) {
    for (
      let turns = state.combat.initiative.length;
      turns > 0 &&
      !state.entities.some(
        (e) => e.id === state.combat.activeEntityId && up(e),
      );
      turns--
    )
      state = advanceTurn(state).state;
  }
  const { pendingReaction, engineReactions, ...rest } = state;
  const reactionDeleted =
    !!pendingReaction &&
    (charIds.has(pendingReaction.entityId) ||
      charIds.has(pendingReaction.moverId));
  const pruned: RoomCombatState = {
    ...rest,
    ...(pendingReaction && !reactionDeleted
      ? { pendingReaction, engineReactions }
      : {}),
    entities: rest.entities.filter((e) => !charIds.has(e.id)),
    combat: {
      ...rest.combat,
      initiative: rest.combat.initiative.filter(
        (item) => !charIds.has(item.entityId),
      ),
      resources: withoutKeys(rest.combat.resources, charIds),
    },
    ...(rest.concentration
      ? { concentration: withoutKeys(rest.concentration, charIds) }
      : {}),
  };
  const active = pruned.combat.activeEntityId;
  const dangling = !!active && !pruned.entities.some((e) => e.id === active);
  if (
    pruned.ended ||
    (!dangling && pruned.entities.some((e) => e.team === 'party'))
  )
    return pruned.ended ? pruned : settle(pruned).state;
  // No party seat left (or no party member up to take the turn): close combat cleanly.
  const open = { ...pruned };
  delete open.pendingReaction;
  delete open.engineReactions;
  return {
    ...open,
    ended: { outcome: 'dm-ended' },
    combat: { ...open.combat, activeEntityId: null },
  };
}

function isDeletedCharacterRef(item: unknown, charIds: Set<string>) {
  if (!isRecord(item)) return false;
  return (
    (typeof item.id === 'string' && charIds.has(item.id)) ||
    (typeof item.entityId === 'string' && charIds.has(item.entityId))
  );
}

function withoutKeys<T>(record: Record<string, T>, keys: Set<string>) {
  return Object.fromEntries(
    Object.entries(record).filter(([key]) => !keys.has(key)),
  ) as Record<string, T>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export async function runAccountDeletions(ctx: JobContext & { db: Pool }) {
  const ids = (
    await ctx.db.query<{ id: string }>(
      "SELECT id FROM accounts WHERE status='deleting' ORDER BY deletion_requested_at",
    )
  ).rows;
  let deleted = 0;
  let held = 0;
  let failed = 0;
  for (const { id } of ids) {
    if (await skipIfHeld(ctx, 'accountDeletion', 'account', id)) {
      held++;
      continue;
    }
    // Drain live Rooms (this process) first; the lease fence in the transaction covers the rest.
    if (ctx.drainRoom) {
      const seen = await ctx.db.query<{ session_id: string }>(
        `SELECT id AS session_id FROM sessions WHERE owner_account_id=$1
         UNION SELECT session_id FROM events WHERE type='SeatJoined' AND payload->>'accountId'=$2`,
        [id, id],
      );
      for (const row of seen.rows) await ctx.drainRoom(row.session_id);
    }
    const client = await ctx.db.connect();
    try {
      await client.query('BEGIN');
      const counts = await deleteAccount(ctx, client, id);
      await client.query('COMMIT');
      deleted++;
      ctx.log({ job: 'accountDeletion', accountId: id, ...counts });
    } catch (error) {
      await client.query('ROLLBACK');
      if ((error as Error).message === HELD) held++;
      else {
        failed++;
        ctx.log({ job: 'accountDeletion', accountId: id, event: 'failed' });
      }
    } finally {
      client.release();
    }
  }
  ctx.log({ job: 'accountDeletion', deleted, held, failed });
  return { deleted, held, failed };
}
