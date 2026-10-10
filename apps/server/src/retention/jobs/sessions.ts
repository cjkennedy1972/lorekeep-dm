import { skipIfHeld, type JobContext } from '../types.js';

/** ADR-017: archived gameplay is deleted 90 days after archive; a legal hold suspends deletion for that item. */
export async function purgeArchivedSessions(ctx: JobContext) {
  const cutoff = new Date(ctx.now.getTime() - 90 * 86_400_000);
  const rows = (
    await ctx.db.query<{ id: string }>(
      "SELECT id FROM sessions WHERE status='archived' AND archived_at < $1",
      [cutoff],
    )
  ).rows;
  let deleted = 0;
  let held = 0;
  for (const { id } of rows) {
    if (await skipIfHeld(ctx, 'sessions', 'session', id)) {
      held++;
      continue;
    }
    const purged = (
      await ctx.db.query<{ purged: boolean }>(
        'SELECT purge_archived_session($1,$2) AS purged',
        [id, cutoff],
      )
    ).rows[0]!.purged;
    if (purged) deleted++;
  }
  ctx.log({ job: 'sessions', deleted, held });
  return { deleted, held };
}
