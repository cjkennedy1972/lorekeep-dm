import type { JobContext } from '../types.js';

/**
 * Deletes message reports past expires_at; their audit rows cascade with them. A session legal
 * hold keeps its reports and logs one skip per session, not one per sweep.
 */
export async function purgeExpiredReports(ctx: JobContext) {
  const expired = (
    await ctx.db.query<{ id: string; session_id: string; held: boolean }>(
      `SELECT r.id, r.session_id,
         EXISTS (SELECT 1 FROM legal_holds h WHERE h.kind='session' AND h.item_id=r.session_id::text) AS held
       FROM message_reports r WHERE r.expires_at < $1`,
      [ctx.now],
    )
  ).rows;
  const heldSessions = new Set<string>();
  let deleted = 0;
  let held = 0;
  for (const { id, session_id, held: isHeld } of expired) {
    if (isHeld) {
      heldSessions.add(session_id);
      held++;
      continue;
    }
    await ctx.db.query('DELETE FROM message_reports WHERE id=$1', [id]);
    deleted++;
  }
  for (const sessionId of heldSessions)
    await ctx.db.query(
      `INSERT INTO retention_audit(job,item_kind,item_id,action)
       SELECT 'reports','session',$1,'skipped_legal_hold'
       WHERE NOT EXISTS (SELECT 1 FROM retention_audit
         WHERE job='reports' AND item_kind='session' AND item_id=$1 AND action='skipped_legal_hold')`,
      [sessionId],
    );
  ctx.log({ job: 'reports', deleted, held });
  return { deleted, held };
}
