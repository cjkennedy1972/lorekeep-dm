import { randomBytes, createHash } from 'node:crypto';
import type { Pool } from 'pg';

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
      (url.host === host ||
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
export async function eligibleSession(
  db: Pool,
  accountId: string,
  sessionId?: string,
): Promise<string | undefined> {
  const result = await db.query<{ id: string }>(
    `SELECT s.id FROM sessions s WHERE s.status='active' AND ($2::uuid IS NULL OR s.id=$2)
      AND (s.owner_account_id=$1 OR EXISTS (
        SELECT 1 FROM events e WHERE e.session_id=s.id AND e.type='SeatJoined' AND e.payload->>'accountId'=$1::text))
      ORDER BY s.last_active_at DESC LIMIT 1`,
    [accountId, sessionId ?? null],
  );
  return result.rows[0]?.id;
}
export async function issueTicket(
  db: Pool,
  accountId: string,
  sessionId: string,
): Promise<string> {
  const ticket = randomBytes(32).toString('base64url');
  await db.query(
    `INSERT INTO ws_tickets(ticket_hash,account_id,session_id,expires_at)
    VALUES($1,$2,$3,clock_timestamp() + interval '30 seconds')`,
    [hash(ticket), accountId, sessionId],
  );
  return ticket;
}
export async function consumeTicket(
  db: Pool,
  ticket: string,
  sessionId?: string,
): Promise<{ accountId: string; sessionId: string } | undefined> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(ticket)) return undefined;
  const result = await db.query<{ account_id: string; session_id: string }>(
    `UPDATE ws_tickets SET used_at=clock_timestamp() WHERE ticket_hash=$1 AND used_at IS NULL
      AND expires_at>clock_timestamp() AND ($2::uuid IS NULL OR session_id=$2)
      RETURNING account_id,session_id`,
    [hash(ticket), sessionId ?? null],
  );
  const row = result.rows[0];
  return row
    ? { accountId: row.account_id, sessionId: row.session_id }
    : undefined;
}
