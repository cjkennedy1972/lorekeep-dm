import type { Pool } from 'pg';
import type { ObjectStore } from '../storage/objectStore.js';
import { purgeLogs } from './jobs/logs.js';
import { purgeExports } from './jobs/exports.js';
import { runAccountDeletions } from './jobs/accountDeletion.js';
import type { SweepLog } from './types.js';

export const STALE_AFTER_MS = 26 * 3600_000;
const LOCK_KEY = 7_201_906; // arbitrary constant for pg_try_advisory_lock

export interface SweepOptions {
  store: ObjectStore;
  now?: () => Date;
  log?: SweepLog;
}
export const consoleLog: SweepLog = (entry) =>
  console.log(JSON.stringify({ component: 'retention', ...entry }));

/** One idempotent sweep. Returns undefined when another sweep holds the advisory lock. */
export async function runSweep(db: Pool, options: SweepOptions) {
  const client = await db.connect();
  try {
    const got = (
      await client.query<{ ok: boolean }>(
        'SELECT pg_try_advisory_lock($1) AS ok',
        [LOCK_KEY],
      )
    ).rows[0]!.ok;
    if (!got) return undefined;
    try {
      const ctx = {
        db,
        store: options.store,
        now: (options.now ?? (() => new Date()))(),
        log: options.log ?? consoleLog,
      };
      const logs = await purgeLogs(ctx);
      await db.query(
        "UPDATE sessions SET status='archived', archived_at=$1 WHERE status='active' AND last_active_at < $2",
        [ctx.now, new Date(ctx.now.getTime() - 14 * 86_400_000)],
      );
      await db.query('DELETE FROM endpoint_usage WHERE created_at < $1', [
        new Date(ctx.now.getTime() - 30 * 86_400_000),
      ]);
      const exports = await purgeExports(ctx);
      const accounts = await runAccountDeletions(ctx);
      if (accounts.failed === 0) {
        await db.query(
          `INSERT INTO retention_state(id,last_completed_at) VALUES('sweeper',$1)
           ON CONFLICT (id) DO UPDATE SET last_completed_at=EXCLUDED.last_completed_at`,
          [ctx.now],
        );
      }
      return { logs, exports, accounts };
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}

/** Stale (or never run) after 26 h. Exposes timestamps only, no data. */
export async function retentionHealth(
  db: Pick<Pool, 'query'>,
  now = new Date(),
) {
  const row = (
    await db.query<{ last_completed_at: Date }>(
      "SELECT last_completed_at FROM retention_state WHERE id='sweeper'",
    )
  ).rows[0];
  const last = row ? new Date(row.last_completed_at) : undefined;
  return {
    lastCompletedAt: last?.toISOString() ?? null,
    stale: !last || now.getTime() - last.getTime() > STALE_AFTER_MS,
  };
}

/** In-process scheduler; overlapping runs are prevented by the advisory lock. */
export function startSweepScheduler(
  db: Pool,
  store: ObjectStore,
  intervalMs: number,
) {
  const tick = () =>
    void runSweep(db, { store }).catch(() =>
      consoleLog({ job: 'sweep', event: 'failed' }),
    );
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  setTimeout(tick, 5_000).unref();
  return () => clearInterval(timer);
}
