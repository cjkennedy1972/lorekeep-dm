import type { Pool } from 'pg';
import { hashToken } from './signup.js';
export async function verifyEmail(
  db: Pool,
  token: string,
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
    await client.query(
      `UPDATE accounts SET status='active' WHERE id=$1 AND status='pending_email'`,
      [result.rows[0].account_id],
    );
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
