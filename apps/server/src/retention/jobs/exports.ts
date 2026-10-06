import { skipIfHeld, type JobContext } from '../types.js';

export async function removeArchive(ctx: JobContext, key: string | null) {
  if (!key) return;
  try {
    await ctx.store.delete(key);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/** Export archives expire after 7 days: delete the file, then the row. */
export async function purgeExports(ctx: JobContext) {
  const rows = (
    await ctx.db.query<{ id: string; archive_key: string | null }>(
      'SELECT id,archive_key FROM export_jobs WHERE expires_at < $1',
      [ctx.now],
    )
  ).rows;
  let deleted = 0;
  let held = 0;
  for (const row of rows) {
    if (await skipIfHeld(ctx, 'exports', 'export', row.id)) {
      held++;
      continue;
    }
    await removeArchive(ctx, row.archive_key);
    await ctx.db.query('DELETE FROM export_jobs WHERE id=$1', [row.id]);
    deleted++;
  }
  ctx.log({ job: 'exports', deleted, held });
  return { deleted, held };
}
