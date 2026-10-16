import type { Pool } from 'pg';

export async function deleteTestSessions(
  pool: Pool,
  sessionIds: readonly string[],
) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      "SELECT set_config('lorekeep.redacting_event', 'on', true)",
    );
    for (const id of sessionIds)
      await client.query('DELETE FROM sessions WHERE id=$1', [id]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
