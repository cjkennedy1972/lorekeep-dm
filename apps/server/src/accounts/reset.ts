import { randomBytes } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { sendBestEffort, type EmailSender } from '../email/sender.js';
import { hashPassword, validPassword } from './password.js';
import { hashToken } from './signup.js';

export const forgotResponse = {};
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export async function requestPasswordReset(
  db: Pool,
  sender: EmailSender,
  email: string,
  now = new Date(),
): Promise<{ sent?: Promise<string | undefined> }> {
  // Identical expensive work for known and unknown addresses.
  await hashPassword(randomBytes(32).toString('base64url'));
  const account = await db.query(
    "SELECT id FROM accounts WHERE email=$1 AND status IN ('active','pending_email')",
    [email.trim().toLowerCase()],
  );
  if (!account.rowCount) return {};
  const token = randomBytes(32).toString('base64url');
  // Only the latest link works: retire older unused ones in the same transaction.
  await inAccountLock(db, account.rows[0].id, async (client) => {
    await invalidateResetTokens(client, account.rows[0].id, now);
    await client.query(
      "INSERT INTO email_tokens(token_hash,account_id,kind,expires_at) VALUES ($1,$2,'reset',$3)",
      [
        hashToken(token),
        account.rows[0].id,
        new Date(now.getTime() + 3600_000),
      ],
    );
  });
  // The link is committed; a failed send leaves the user able to request another one. Not awaited: send latency must not distinguish known from unknown addresses.
  const sent = sendBestEffort(async () => {
    await sender.sendPasswordReset?.(email.trim().toLowerCase(), token);
  });
  return { sent };
}

export async function invalidateResetTokens(
  client: Pick<PoolClient, 'query'>,
  accountId: string,
  now = new Date(),
): Promise<void> {
  await client.query(
    "UPDATE email_tokens SET used_at=$2 WHERE account_id=$1 AND kind='reset' AND used_at IS NULL",
    [accountId, now],
  );
}

/** Runs `work` in a transaction holding a row lock on the account, serializing concurrent credential changes. */
export async function inAccountLock<T>(
  db: Pool,
  accountId: string,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT 1 FROM accounts WHERE id=$1 FOR UPDATE', [
      accountId,
    ]);
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** Authenticated password change: retires every outstanding reset link and every other auth session. */
export async function changePassword(
  db: Pool,
  accountId: string,
  keepTokenHash: string,
  passwordHash: string,
): Promise<void> {
  await inAccountLock(db, accountId, async (client) => {
    await client.query('UPDATE accounts SET password_hash=$2 WHERE id=$1', [
      accountId,
      passwordHash,
    ]);
    await invalidateResetTokens(client, accountId);
    await client.query(
      'DELETE FROM auth_sessions WHERE account_id=$1 AND token_hash<>$2',
      [accountId, keepTokenHash],
    );
  });
}

export async function confirmPasswordReset(
  db: Pool,
  token: string,
  password: string,
  now = new Date(),
): Promise<boolean> {
  if (!TOKEN_PATTERN.test(token) || !validPassword(password)) return false;
  const passwordHash = await hashPassword(password);
  const owner = await db.query(
    "SELECT account_id FROM email_tokens WHERE token_hash=$1 AND kind='reset'",
    [hashToken(token)],
  );
  if (owner.rowCount !== 1) return false;
  class Abort extends Error {}
  return inAccountLock(db, owner.rows[0].account_id, async (client) => {
    const used = await client.query(
      "UPDATE email_tokens SET used_at=$2 WHERE token_hash=$1 AND kind='reset' AND used_at IS NULL AND expires_at>$2 RETURNING account_id",
      [hashToken(token), now],
    );
    if (used.rowCount !== 1) return false;
    const changed = await client.query(
      "UPDATE accounts SET password_hash=$2 WHERE id=$1 AND status IN ('active','pending_email') RETURNING id",
      [used.rows[0].account_id, passwordHash],
    );
    if (changed.rowCount !== 1) throw new Abort(); // roll back: token stays unused
    await invalidateResetTokens(client, used.rows[0].account_id, now);
    await client.query('DELETE FROM auth_sessions WHERE account_id=$1', [
      used.rows[0].account_id,
    ]);
    return true;
  }).catch((error: unknown) => {
    if (error instanceof Abort) return false;
    throw error;
  });
}
