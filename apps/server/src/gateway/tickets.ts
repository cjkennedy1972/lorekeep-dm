import { randomBytes, createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { originHostMatches } from '../middleware/origin.js';
import { currentMemberSql } from '../room/membership.js';

const hash = (ticket: string) =>
  createHash('sha256').update(ticket).digest('hex');
export function validOrigin(
  origin: string | undefined,
  host: string | undefined,
  allowed = process.env.WS_ALLOWED_ORIGINS,
): boolean {
  if (!origin || !host) return false;
  try {
    const url = new URL(origin);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      (originHostMatches(url, host) ||
        (allowed
          ?.split(',')
          .map((v) => v.trim())
          .includes(url.origin) ??
          false))
    );
  } catch {
    return false;
  }
}

/** Exact normalized-origin allowlist check used only as the ticket-route bypass. */
export function isConfiguredOriginAllowed(
  origin: string | undefined,
  allowed = process.env.WS_ALLOWED_ORIGINS,
): boolean {
  if (!origin || !allowed) return false;
  try {
    const parsedOrigin = new URL(origin);
    if (
      parsedOrigin.pathname !== '/' ||
      parsedOrigin.search ||
      parsedOrigin.hash
    )
      return false;
    const normalized = parsedOrigin.origin;
    return allowed
      .split(',')
      .map((value) => value.trim())
      .includes(normalized);
  } catch {
    return false;
  }
}
export async function eligibleSession(
  db: Pool,
  accountId: string,
  sessionId?: string,
): Promise<string | undefined> {
  const result = await db.query<{ id: string }>(
    `SELECT s.id FROM sessions s WHERE s.status='active' AND ($2::uuid IS NULL OR s.id=$2)
      AND (s.owner_account_id=$1 OR ${currentMemberSql('$1')})
      ORDER BY s.last_active_at DESC LIMIT 1`,
    [accountId, sessionId ?? null],
  );
  return result.rows[0]?.id;
}
export async function issueTicket(
  db: Pool,
  accountId: string,
  sessionId: string,
  authTokenHash: string,
  seatId?: string,
): Promise<string> {
  const ticket = randomBytes(32).toString('base64url');
  const resolvedSeatId =
    seatId ??
    (
      await db.query<{ seat_id: string }>(
        `SELECT j.payload->>'seatId' AS seat_id FROM events j
      WHERE j.session_id=$1 AND j.type='SeatJoined'
        AND j.payload->>'accountId'=$2
        AND NOT EXISTS (SELECT 1 FROM events r WHERE r.session_id=j.session_id
          AND r.type='SeatRevoked' AND r.payload->>'seatId'=j.payload->>'seatId'
          AND r.seq>j.seq)
      ORDER BY j.seq DESC LIMIT 1`,
        [sessionId, accountId],
      )
    ).rows[0]?.seat_id;
  if (!resolvedSeatId)
    throw new Error('Cannot issue a ticket without a current seat');
  await db.query(
    `INSERT INTO ws_tickets(ticket_hash,account_id,session_id,seat_id,auth_token_hash,expires_at)
    VALUES($1,$2,$3,$4,$5,clock_timestamp() + interval '30 seconds')`,
    [hash(ticket), accountId, sessionId, resolvedSeatId, authTokenHash],
  );
  return ticket;
}
export async function consumeTicket(
  db: Pool,
  ticket: string,
  sessionId?: string,
): Promise<
  | {
      accountId: string;
      sessionId: string;
      seatId: string;
      authTokenHash: string;
    }
  | undefined
> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(ticket)) return undefined;
  // Consumable only while the originating auth session, account, and table membership remain valid.
  const result = await db.query<{
    account_id: string;
    session_id: string;
    seat_id: string;
    auth_token_hash: string;
  }>(
    `UPDATE ws_tickets t SET used_at=clock_timestamp()
      FROM auth_sessions s, accounts a, sessions room
      WHERE t.ticket_hash=$1 AND t.used_at IS NULL
      AND t.expires_at>clock_timestamp() AND ($2::uuid IS NULL OR t.session_id=$2)
      AND s.token_hash=t.auth_token_hash AND s.account_id=t.account_id
      AND s.expires_at>clock_timestamp() AND s.absolute_expires_at>clock_timestamp()
      AND a.id=t.account_id AND a.status='active'
      AND room.id=t.session_id AND (room.owner_account_id=t.account_id OR ${currentMemberSql('t.account_id', 'room')})
      AND EXISTS (SELECT 1 FROM events j WHERE j.session_id=t.session_id
        AND j.type='SeatJoined' AND j.payload->>'seatId'=t.seat_id::text
        AND j.payload->>'accountId'=t.account_id::text
        AND NOT EXISTS (SELECT 1 FROM events r WHERE r.session_id=j.session_id
          AND r.type='SeatRevoked' AND r.payload->>'seatId'=t.seat_id::text
          AND r.seq>j.seq))
      RETURNING t.account_id,t.session_id,t.seat_id,t.auth_token_hash`,
    [hash(ticket), sessionId ?? null],
  );
  const row = result.rows[0];
  return row
    ? {
        accountId: row.account_id,
        sessionId: row.session_id,
        seatId: row.seat_id,
        authTokenHash: row.auth_token_hash,
      }
    : undefined;
}
