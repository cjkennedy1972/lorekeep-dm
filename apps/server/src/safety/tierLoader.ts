import type { Pool } from 'pg';

type Queryable = Pick<Pool, 'query'>;

/**
 * Live mature opt-out for every account that has ever been seated in the session. The seat's
 * join-time snapshot is not used; a seated account with no row counts as opted out.
 */
export async function loadSeatedMatureOptOuts(
  db: Queryable,
  sessionId: string,
): Promise<boolean[]> {
  const { rows } = await db.query<{ opted_out: boolean }>(
    `SELECT COALESCE(a.mature_opt_out, true) AS opted_out
       FROM (SELECT DISTINCT payload->>'accountId' AS account_id FROM events
              WHERE session_id=$1 AND type='SeatJoined' AND payload->>'accountId' IS NOT NULL) seated
       LEFT JOIN accounts a ON a.id = seated.account_id::uuid`,
    [sessionId],
  );
  return rows.map((row) => row.opted_out);
}
