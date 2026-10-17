import type { Pool } from 'pg';

export async function deleteTestSessions(
  pool: Pool,
  sessionIds: readonly string[],
) {
  for (const id of sessionIds) await pool.query('SELECT purge_session($1)', [id]);
}
