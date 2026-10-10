import { randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { hashToken } from './signup.js';
import { hashPassword } from './password.js';
import { inAccountLock } from './reset.js';

const VERIFY_TTL_MS = 24 * 3600_000;

/** Returns a fresh token for a pending account, retiring earlier ones; undefined when nothing is pending. */
export async function resendVerification(
  db: Pool,
  email: string,
  now = new Date(),
): Promise<string | undefined> {
  // Identical expensive work for known and unknown addresses, as requestPasswordReset does.
  await hashPassword(randomBytes(32).toString('base64url'));
  const account = await db.query(
    "SELECT id FROM accounts WHERE email=$1 AND status='pending_email'",
    [email],
  );
  if (!account.rowCount) return undefined;
  const accountId = account.rows[0].id as string;
  const token = randomBytes(32).toString('base64url');
  let issued = false;
  await inAccountLock(db, accountId, async (client) => {
    const pending = await client.query(
      "SELECT 1 FROM accounts WHERE id=$1 AND status='pending_email'",
      [accountId],
    );
    if (!pending.rowCount) return;
    await client.query(
      "UPDATE email_tokens SET used_at=$2 WHERE account_id=$1 AND kind='verify' AND used_at IS NULL",
      [accountId, now],
    );
    await client.query(
      "INSERT INTO email_tokens(token_hash,account_id,kind,expires_at) VALUES ($1,$2,'verify',$3)",
      [hashToken(token), accountId, new Date(now.getTime() + VERIFY_TTL_MS)],
    );
    issued = true;
  });
  return issued ? token : undefined;
}
// The verifier's own password replaces the signup-time one, so a link started by someone else never activates their password.
export async function verifyEmail(
  db: Pool,
  token: string,
  password: string,
  now: Date = new Date(),
): Promise<boolean> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return false;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `UPDATE email_tokens SET used_at=$2 WHERE token_hash=$1 AND kind='verify' AND used_at IS NULL AND expires_at>$2 RETURNING account_id`,
      [hashToken(token), now],
    );
    if (result.rowCount !== 1) {
      await client.query('ROLLBACK');
      return false;
    }
    const passwordHash = await hashPassword(password);
    const activated = await client.query(
      `UPDATE accounts SET status='active', password_hash=$2 WHERE id=$1 AND status='pending_email'`,
      [result.rows[0].account_id, passwordHash],
    );
    if (activated.rowCount !== 1) {
      await client.query('ROLLBACK');
      return false;
    }
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
