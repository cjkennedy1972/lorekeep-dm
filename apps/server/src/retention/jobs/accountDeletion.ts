import type { Pool, PoolClient } from 'pg';
import { removeArchive } from './exports.js';
import { skipIfHeld, type JobContext } from '../types.js';

const ANON_NAME = 'Deleted player';

/**
 * ADR-017 account deletion: purge exports, hand off or delete owned rooms,
 * anonymize the account's seats (redact_event is the only event mutation),
 * then hard-delete the accounts row (cascades tokens, auth sessions, tickets, jobs).
 */
async function deleteAccount(
  ctx: JobContext,
  client: PoolClient,
  accountId: string,
) {
  const counts = {
    exports: 0,
    roomsDeleted: 0,
    roomsHandedOff: 0,
    seatsAnonymized: 0,
  };
  const exportRows = (
    await client.query<{ archive_key: string | null }>(
      'SELECT archive_key FROM export_jobs WHERE account_id=$1',
      [accountId],
    )
  ).rows;
  for (const r of exportRows) await removeArchive(ctx, r.archive_key);
  counts.exports = exportRows.length;

  const owned = (
    await client.query<{ id: string }>(
      'SELECT id FROM sessions WHERE owner_account_id=$1',
      [accountId],
    )
  ).rows;
  for (const { id } of owned) {
    if (await skipIfHeld(ctx, 'accountDeletion', 'session', id)) {
      throw new Error('HELD_SESSION');
    }
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
        'UPDATE sessions SET owner_account_id=$2 WHERE id=$1',
        [id, heir.account_id],
      );
      counts.roomsHandedOff++;
    } else {
      await client.query('SELECT purge_session($1)', [id]);
      counts.roomsDeleted++;
    }
  }

  const seats = (
    await client.query<{
      session_id: string;
      seq: string;
      payload: Record<string, unknown>;
    }>(
      `SELECT session_id,seq,payload FROM events WHERE type='SeatJoined' AND payload->>'accountId'=$1`,
      [accountId],
    )
  ).rows;
  for (const s of seats) {
    await client.query('SELECT redact_event($1,$2,$3)', [
      s.session_id,
      s.seq,
      {
        ...s.payload,
        accountId: s.payload.seatId,
        displayName: ANON_NAME,
        anonymized: true,
      },
    ]);
    counts.seatsAnonymized++;
  }
  const snaps = (
    await client.query<{
      session_id: string;
      seq: string;
      state: { seats?: Record<string, unknown>[] };
    }>('SELECT session_id,seq,state FROM snapshots WHERE state @> $1::jsonb', [
      JSON.stringify({ seats: [{ accountId }] }),
    ])
  ).rows;
  for (const s of snaps) {
    const seatsState = (s.state.seats ?? []).map((seat) =>
      seat.accountId === accountId
        ? {
            ...seat,
            accountId: seat.seatId,
            displayName: ANON_NAME,
            anonymized: true,
          }
        : seat,
    );
    await client.query(
      'UPDATE snapshots SET state=$3 WHERE session_id=$1 AND seq=$2',
      [s.session_id, s.seq, { ...s.state, seats: seatsState }],
    );
  }
  await client.query('DELETE FROM accounts WHERE id=$1', [accountId]);
  return counts;
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
    const client = await ctx.db.connect();
    try {
      await client.query('BEGIN');
      const counts = await deleteAccount(ctx, client, id);
      await client.query('COMMIT');
      deleted++;
      ctx.log({ job: 'accountDeletion', accountId: id, ...counts });
    } catch (error) {
      await client.query('ROLLBACK');
      if ((error as Error).message === 'HELD_SESSION') held++;
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
