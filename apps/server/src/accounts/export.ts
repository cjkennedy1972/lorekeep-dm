import { randomUUID, createHmac, timingSafeEqual } from 'node:crypto';
import type { Pool } from 'pg';
import type { ObjectStore } from '../storage/objectStore.js';
const WEEK = 7 * 86400_000;

export async function createExport(
  db: Pool,
  accountId: string,
  store: ObjectStore,
) {
  const id = randomUUID();
  await db.query('INSERT INTO export_jobs(id,account_id) VALUES($1,$2)', [
    id,
    accountId,
  ]);
  // The job is persisted before processing; a future worker can retry pending jobs.
  void processExport(db, id, accountId, store).catch(() => undefined);
  return { status: 'pending' as const, requestedAt: new Date().toISOString() };
}
export async function processExport(
  db: Pool,
  id: string,
  accountId: string,
  store: ObjectStore,
) {
  await db.query(
    "UPDATE export_jobs SET status='running' WHERE id=$1 AND status='pending'",
    [id],
  );
  try {
    const profile = (
      await db.query(
        'SELECT id,email,display_name,status,is_adult,age_checked_at,terms_version,terms_accepted_at,mature_opt_out,created_at FROM accounts WHERE id=$1',
        [accountId],
      )
    ).rows[0];
    const sessions = (
      await db.query(
        'SELECT ua_label,last_active_at,expires_at,absolute_expires_at FROM auth_sessions WHERE account_id=$1',
        [accountId],
      )
    ).rows;
    const ownedRooms = (
      await db.query(
        'SELECT id,status,created_at,last_active_at,archived_at FROM sessions WHERE owner_account_id=$1',
        [accountId],
      )
    ).rows;
    const archive = {
      exportedAt: new Date().toISOString(),
      profile,
      sessions,
      ownedRooms,
      characters: [],
      snapshots: [],
      summaries: [],
      transcripts: [],
    };
    const key = `${id}.json`;
    await store.put(key, JSON.stringify(archive));
    await db.query(
      "UPDATE export_jobs SET status='completed',completed_at=now(),expires_at=$2,archive_key=$3 WHERE id=$1",
      [id, new Date(Date.now() + WEEK), key],
    );
  } catch {
    await db.query(
      "UPDATE export_jobs SET status='failed',error_code='EXPORT_FAILED' WHERE id=$1",
      [id],
    );
  }
}
export async function latestExport(db: Pool, accountId: string) {
  const row = (
    await db.query(
      'SELECT id,status,requested_at,expires_at,archive_key FROM export_jobs WHERE account_id=$1 ORDER BY requested_at DESC LIMIT 1',
      [accountId],
    )
  ).rows[0];
  return row;
}
export function exportStatus(
  row:
    | {
        id: string;
        status: string;
        requested_at: Date | string;
        expires_at: Date | string;
      }
    | undefined,
  secret: string,
) {
  if (!row) return null;
  const requestedAt = new Date(row.requested_at).toISOString();
  if (row.status === 'failed') return { status: 'expired', requestedAt };
  if (row.status !== 'completed') return { status: 'pending', requestedAt };
  const expiresAt = new Date(row.expires_at).toISOString();
  if (Date.now() >= new Date(row.expires_at).getTime())
    return { status: 'expired', requestedAt };
  const signature = sign(row.id, expiresAt, secret);
  return {
    status: 'ready',
    requestedAt,
    expiresAt,
    downloadUrl: `/api/me/export?id=${row.id}&expires=${encodeURIComponent(expiresAt)}&sig=${signature}`,
  };
}
function sign(id: string, expires: string, secret: string) {
  return createHmac('sha256', secret).update(`${id}:${expires}`).digest('hex');
}
export function validExportSignature(
  id: string,
  expires: string,
  signature: string,
  secret: string,
) {
  if (
    !/^[a-f0-9]{64}$/.test(signature) ||
    Date.now() >= new Date(expires).getTime()
  )
    return false;
  return timingSafeEqual(
    Buffer.from(signature, 'hex'),
    Buffer.from(sign(id, expires, secret), 'hex'),
  );
}
