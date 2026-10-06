import { randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import type { EmailSender } from '../email/sender.js';
import { hashPassword, validPassword } from './password.js';
import { hashToken } from './signup.js';

export const forgotResponse = {};
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export async function requestPasswordReset(
  db: Pool,
  sender: EmailSender,
  email: string,
  now = new Date(),
): Promise<typeof forgotResponse> {
  // Identical expensive work for known and unknown addresses.
  await hashPassword(randomBytes(32).toString('base64url'));
  const account = await db.query(
    "SELECT id FROM accounts WHERE email=$1 AND status IN ('active','pending_email')",
    [email.trim().toLowerCase()],
  );
  if (account.rowCount) {
    const token = randomBytes(32).toString('base64url');
    await db.query(
      "INSERT INTO email_tokens(token_hash,account_id,kind,expires_at) VALUES ($1,$2,'reset',$3)",
      [
        hashToken(token),
        account.rows[0].id,
        new Date(now.getTime() + 3600_000),
      ],
    );
    await sender.sendPasswordReset?.(email.trim().toLowerCase(), token);
  }
  return forgotResponse;
}

export async function confirmPasswordReset(
  db: Pool,
  token: string,
  password: string,
  now = new Date(),
): Promise<boolean> {
  if (!TOKEN_PATTERN.test(token) || !validPassword(password)) return false;
  const passwordHash = await hashPassword(password);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const used = await client.query(
      "UPDATE email_tokens SET used_at=$2 WHERE token_hash=$1 AND kind='reset' AND used_at IS NULL AND expires_at>$2 RETURNING account_id",
      [hashToken(token), now],
    );
    if (used.rowCount !== 1) {
      await client.query('ROLLBACK');
      return false;
    }
    const changed = await client.query(
      "UPDATE accounts SET password_hash=$2 WHERE id=$1 AND status IN ('active','pending_email') RETURNING id",
      [used.rows[0].account_id, passwordHash],
    );
    if (changed.rowCount !== 1) {
      await client.query('ROLLBACK');
      return false;
    }
    await client.query('DELETE FROM auth_sessions WHERE account_id=$1', [
      used.rows[0].account_id,
    ]);
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
