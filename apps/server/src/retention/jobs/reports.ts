import { skipIfHeld, type JobContext } from '../types.js';

/** Deletes message reports and their audit rows past expires_at; a session legal hold keeps them. */
export async function purgeExpiredReports(ctx: JobContext) {
  const rows = (
    await ctx.db.query<{ id: string; session_id: string }>(
      'SELECT id, session_id FROM message_reports WHERE expires_at < $1',
      [ctx.now],
    )
  ).rows;
  let deleted = 0;
  let held = 0;
  for (const { id, session_id } of rows) {
    if (await skipIfHeld(ctx, 'reports', 'session', session_id)) {
      held++;
      continue;
    }
    await ctx.db.query('DELETE FROM message_reports WHERE id=$1', [id]);
    deleted++;
  }
  const auditDeleted =
    (
      await ctx.db.query(
        `DELETE FROM message_report_audit a USING message_reports r
       WHERE a.report_id = r.id AND a.expires_at < $1
         AND NOT EXISTS (SELECT 1 FROM legal_holds h WHERE h.kind='session' AND h.item_id=r.session_id::text)`,
        [ctx.now],
      )
    ).rowCount ?? 0;
  ctx.log({ job: 'reports', deleted, held, auditDeleted });
  return { deleted, held, auditDeleted };
}
