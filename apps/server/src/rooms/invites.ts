import { createHash, randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { currentMemberSql } from '../room/membership.js';

export const MAX_SEATS = 6;
const CODE_RE = /^[A-Za-z0-9_-]{22}$/;
/** 16 random bytes = 128 bits of entropy, base64url (22 chars). */
export const newInviteCode = () => randomBytes(16).toString('base64url');
export const hashInvite = (code: string) =>
  createHash('sha256').update(code).digest('hex');
export const plausibleCode = (code: string) => CODE_RE.test(code);

/** Mint (or replace) the invite for a room the account owns; the old code stops working at once. */
export async function setInvite(
  db: Pick<Pool, 'query'>,
  sessionId: string,
  ownerId: string,
): Promise<string | undefined> {
  const code = newInviteCode();
  const r = await db.query(
    `UPDATE sessions SET invite_hash=$3 WHERE id=$1 AND owner_account_id=$2 AND status='active'`,
    [sessionId, ownerId, hashInvite(code)],
  );
  return r.rowCount ? code : undefined;
}
export async function revokeInvite(
  db: Pick<Pool, 'query'>,
  sessionId: string,
  ownerId: string,
): Promise<boolean> {
  const r = await db.query(
    `UPDATE sessions SET invite_hash=NULL WHERE id=$1 AND owner_account_id=$2 AND status='active'`,
    [sessionId, ownerId],
  );
  return !!r.rowCount;
}
export async function sessionForCode(
  db: Pick<Pool, 'query'>,
  code: string,
): Promise<
  | {
      id: string;
      name: string;
      owner: string;
      status: string;
      hostTierCap: 'family' | 'standard' | null;
    }
  | undefined
> {
  if (!plausibleCode(code)) return undefined;
  const r = await db.query<{
    id: string;
    name: string;
    owner: string;
    status: string;
    host_tier_cap: 'family' | 'standard' | null;
  }>(
    `SELECT s.id,s.name,s.owner_account_id AS owner,s.status,s.host_tier_cap FROM sessions s
       WHERE s.invite_hash=$1 AND s.status IN ('active','archived')`,
    [hashInvite(code)],
  );
  const row = r.rows[0];
  return row
    ? {
        id: row.id,
        name: row.name,
        owner: row.owner,
        status: row.status,
        hostTierCap: row.host_tier_cap,
      }
    : undefined;
}
/** A table archived for inactivity comes back when one of its members (or the host) rejoins. */
export async function restoreForMember(
  db: Pick<Pool, 'query'>,
  sessionId: string,
  accountId: string,
): Promise<boolean> {
  const r = await db.query(
    `UPDATE sessions s SET status='active', archived_at=NULL, last_active_at=now()
      WHERE s.id=$1 AND s.status='archived' AND (s.owner_account_id=$2 OR ${currentMemberSql('$2')})`,
    [sessionId, accountId],
  );
  return !!r.rowCount;
}
