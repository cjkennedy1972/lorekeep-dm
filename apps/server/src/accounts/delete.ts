import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { verifyPassword } from './password.js';

/** Schedules erasure. M0-19 sweeper consumes pending deletion_jobs. */
export async function requestDeletion(
  db: Pool,
  accountId: string,
  password: string,
) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const row = (
      await client.query(
        'SELECT password_hash,status FROM accounts WHERE id=$1 FOR UPDATE',
        [accountId],
      )
    ).rows[0];
    if (
      !row ||
      row.status !== 'active' ||
      !(await verifyPassword(row.password_hash, password))
    ) {
      await client.query('ROLLBACK');
      return false;
    }
    await client.query(
      "UPDATE accounts SET status='deleting',deletion_requested_at=now() WHERE id=$1",
      [accountId],
    );
    await client.query('DELETE FROM auth_sessions WHERE account_id=$1', [
      accountId,
    ]);
    await client.query('DELETE FROM ws_tickets WHERE account_id=$1', [
      accountId,
    ]);
    await client.query(
      'INSERT INTO deletion_jobs(id,account_id) VALUES($1,$2)',
      [randomUUID(), accountId],
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
