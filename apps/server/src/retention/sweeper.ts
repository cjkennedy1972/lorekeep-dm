import type { Pool } from 'pg';
import type { ObjectStore } from '../storage/objectStore.js';
import { purgeLogs } from './jobs/logs.js';
import { purgeExports } from './jobs/exports.js';
import { purgeArchivedSessions } from './jobs/sessions.js';
import { purgeExpiredReports } from './jobs/reports.js';
import { runAccountDeletions } from './jobs/accountDeletion.js';
import type { SweepLog } from './types.js';
import {
  reconcileDerivedMemoryCharacterRefs,
  type ReferenceCursor,
} from '../dm/characterReferences.js';

export const STALE_AFTER_MS = 26 * 3600_000;
const LOCK_KEY = 7_201_906; // arbitrary constant for pg_try_advisory_lock
const RECONCILIATION_LOCK_KEY = 7_201_907;

export interface SweepOptions {
  store: ObjectStore;
  now?: () => Date;
  log?: SweepLog;
  drainRoom?: (sessionId: string) => Promise<void>;
  reconciliationBatchSize?: number;
  reconciliationTimeBudgetMs?: number;
  coverageEscalationMs?: number;
  /** Monotonic clock seam for deterministic budget tests. */
  monotonicNowMs?: () => number;
}
export const consoleLog: SweepLog = (entry) =>
  console.log(JSON.stringify({ component: 'retention', ...entry }));

export const DEFAULT_RECONCILIATION_BATCH_SIZE = 100;
export const DEFAULT_RECONCILIATION_TIME_BUDGET_MS = 2_000;
export const DEFAULT_COVERAGE_ESCALATION_MS = 24 * 3600_000;

type ReconciliationSummary = {
  batches: number;
  processed: number;
  complete: boolean;
  locked: boolean;
};

/** Runs existing step-1 reconciliation in resumable batches under its own session advisory lock. */
export async function reconcileDerivedMemoryWithinBudget(
  db: Pool,
  batchSize = DEFAULT_RECONCILIATION_BATCH_SIZE,
  timeBudgetMs = DEFAULT_RECONCILIATION_TIME_BUDGET_MS,
  monotonicNowMs: () => number = () => performance.now(),
): Promise<ReconciliationSummary> {
  const client = await db.connect();
  try {
    const locked = (
      await client.query<{ ok: boolean }>(
        'SELECT pg_try_advisory_lock($1) AS ok',
        [RECONCILIATION_LOCK_KEY],
      )
    ).rows[0]?.ok;
    if (!locked)
      return { batches: 0, processed: 0, complete: false, locked: true };
    const startedAt = monotonicNowMs();
    let batches = 0;
    let processed = 0;
    let complete = false;
    try {
      do {
        const state = (
          await db.query<{
            complete: boolean;
            checkpoint_session_id: string | null;
            checkpoint_row_kind: ReferenceCursor['rowKind'] | null;
            checkpoint_row_id: string | null;
          }>(
            'SELECT complete,checkpoint_session_id,checkpoint_row_kind,checkpoint_row_id FROM derived_memory_reconciliation_state WHERE singleton=true',
          )
        ).rows[0];
        if (!state)
          throw new Error('Derived-memory reconciliation state is missing');
        if (state.complete) {
          complete = true;
          break;
        }
        if (batches > 0 && monotonicNowMs() - startedAt >= timeBudgetMs) break;
        const checkpoint =
          state.checkpoint_session_id &&
          state.checkpoint_row_kind &&
          state.checkpoint_row_id
            ? {
                sessionId: state.checkpoint_session_id,
                rowKind: state.checkpoint_row_kind,
                rowId: state.checkpoint_row_id,
              }
            : null;
        const batch = await reconcileDerivedMemoryCharacterRefs(
          db,
          checkpoint,
          batchSize,
        );
        batches += 1;
        processed += batch.processed;
        complete = batch.complete;
        if (complete || monotonicNowMs() - startedAt >= timeBudgetMs) break;
      } while (true);
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [
        RECONCILIATION_LOCK_KEY,
      ]);
    }
    return { batches, processed, complete, locked: false };
  } finally {
    client.release();
  }
}

async function coverageBlockedDeletionCount(
  db: Pick<Pool, 'query'>,
  cutoff: Date,
): Promise<number> {
  const result = await db.query<{ count: number }>(
    `SELECT count(DISTINCT a.id)::int AS count
       FROM accounts a
       WHERE a.status='deleting' AND a.deletion_requested_at <= $1
         AND (EXISTS (SELECT 1 FROM session_seat_characters b WHERE b.account_id=a.id)
           OR EXISTS (SELECT 1 FROM session_character_tokens t JOIN account_characters c ON c.id=t.character_id WHERE c.account_id=a.id)
           OR EXISTS (SELECT 1 FROM derived_memory_character_refs r JOIN account_characters c ON c.id=r.character_id WHERE c.account_id=a.id)
           OR EXISTS (SELECT 1 FROM sessions s JOIN account_characters c ON s.character_id::text=c.id::text WHERE s.owner_account_id=a.id AND c.account_id=a.id))
         AND EXISTS (SELECT 1 FROM derived_memory_reconciliation_state WHERE singleton=true AND complete=false)`,
    [cutoff],
  );
  return Number(result.rows[0]?.count ?? 0);
}

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
        drainRoom: options.drainRoom,
      };
      const logs = await purgeLogs(ctx);
      await db.query(
        "UPDATE sessions SET status='archived', archived_at=$1 WHERE status='active' AND last_active_at < $2",
        [ctx.now, new Date(ctx.now.getTime() - 14 * 86_400_000)],
      );
      const sessions = await purgeArchivedSessions(ctx);
      await db.query('DELETE FROM endpoint_usage WHERE created_at < $1', [
        new Date(ctx.now.getTime() - 30 * 86_400_000),
      ]);
      const exports = await purgeExports(ctx);
      const reports = await purgeExpiredReports(ctx);
      let reconciliation: ReconciliationSummary;
      try {
        reconciliation = await reconcileDerivedMemoryWithinBudget(
          db,
          options.reconciliationBatchSize ?? DEFAULT_RECONCILIATION_BATCH_SIZE,
          options.reconciliationTimeBudgetMs ??
            DEFAULT_RECONCILIATION_TIME_BUDGET_MS,
          options.monotonicNowMs,
        );
      } catch {
        reconciliation = {
          batches: 0,
          processed: 0,
          complete: false,
          locked: false,
        };
        ctx.log({ job: 'derivedMemoryReconciliation', event: 'failed' });
      }
      const accounts = await runAccountDeletions(ctx);
      const blockedByCoverage = await coverageBlockedDeletionCount(
        db,
        new Date(
          ctx.now.getTime() -
            (options.coverageEscalationMs ?? DEFAULT_COVERAGE_ESCALATION_MS),
        ),
      );
      await db.query(
        `INSERT INTO retention_state(id,last_completed_at,deletions_blocked_by_coverage)
         VALUES('sweeper',CASE WHEN $3::boolean THEN $1::timestamptz ELSE NULL::timestamptz END,$2)
         ON CONFLICT(id) DO UPDATE SET
           deletions_blocked_by_coverage=EXCLUDED.deletions_blocked_by_coverage,
           last_completed_at=CASE WHEN $3 THEN EXCLUDED.last_completed_at ELSE retention_state.last_completed_at END`,
        [ctx.now, blockedByCoverage, accounts.failed === 0],
      );
      if (blockedByCoverage > 0)
        ctx.log({
          level: 'error',
          job: 'accountDeletion',
          event: 'coverage_escalation',
          count: blockedByCoverage,
        });
      return {
        logs,
        sessions,
        exports,
        reports,
        accounts,
        reconciliation,
        deletionsBlockedByCoverage: blockedByCoverage,
      };
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
    await db.query<{ last_completed_at: Date | null }>(
      "SELECT last_completed_at FROM retention_state WHERE id='sweeper'",
    )
  ).rows[0];
  const last = row?.last_completed_at
    ? new Date(row.last_completed_at)
    : undefined;
  return {
    lastCompletedAt: last?.toISOString() ?? null,
    stale: !last || now.getTime() - last.getTime() > STALE_AFTER_MS,
  };
}

/** Emits one line when stale. A health query error is labelled apart from a sweep that never completed. */
export async function logRetentionStale(
  db: Pick<Pool, 'query'>,
  log: SweepLog = consoleLog,
  now = new Date(),
) {
  let health: Awaited<ReturnType<typeof retentionHealth>>;
  try {
    health = await retentionHealth(db, now);
  } catch {
    log({ job: 'health', event: 'stale', cause: 'health_query_error' });
    return;
  }
  if (health.stale)
    log({ job: 'health', event: 'stale', cause: 'sweep_incomplete' });
}

/** In-process scheduler; overlapping runs are prevented by the advisory lock. */
export function startSweepScheduler(
  db: Pool,
  store: ObjectStore,
  intervalMs: number,
  drainRoom?: (sessionId: string) => Promise<void>,
  reconciliationOptions: Pick<
    SweepOptions,
    | 'reconciliationBatchSize'
    | 'reconciliationTimeBudgetMs'
    | 'coverageEscalationMs'
  > = {},
) {
  const tick = () =>
    void runSweep(db, { store, drainRoom, ...reconciliationOptions })
      .catch(() => consoleLog({ job: 'sweep', event: 'failed' }))
      .then(() => logRetentionStale(db));
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  setTimeout(tick, 5_000).unref();
  return () => clearInterval(timer);
}
