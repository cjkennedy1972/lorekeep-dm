import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

const LEGACY_CLEAR_LOCK_KEY = 7_201_939;
const DEFAULT_DRY_RUN_MAX_AGE_MS = 24 * 60 * 60_000;
const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_TIME_BUDGET_MS = 2_000;

export type LegacyClearCounts = {
  sessionsConsidered: number;
  sessionsSkippedHeld: number;
  sessionsDeferred: number;
  sceneSummaries: number;
  registryEntries: number;
  registryFacts: number;
};
export type LegacyClearOutcome =
  | 'dry_run_succeeded'
  | 'live_succeeded'
  | 'live_partial';
export type LegacyClearOptions = {
  enabled?: boolean;
  dryRun?: boolean;
  codeVersion?: string;
  dryRunMaxAgeMs?: number;
  countTolerance?: number;
  batchSize?: number;
  timeBudgetMs?: number;
  now?: () => Date;
  log?: (event: string, counts: LegacyClearCounts, outcome: string) => void;
};
export type LegacyClearResult = {
  runId: string;
  dryRunId: string | null;
  outcome: LegacyClearOutcome;
  counts: LegacyClearCounts;
};

type SessionRow = {
  session_id: string;
  held: boolean;
  deferred: boolean;
  plannedSummaries: number;
  plannedEntries: number;
  plannedFacts: number;
};
type AuditRow = {
  run_id: string;
  dry_run_id?: string | null;
  counts: LegacyClearCounts & Record<string, number>;
  finished_at: Date | null;
  outcome: string;
};
const zeroCounts = (): LegacyClearCounts => ({
  sessionsConsidered: 0,
  sessionsSkippedHeld: 0,
  sessionsDeferred: 0,
  sceneSummaries: 0,
  registryEntries: 0,
  registryFacts: 0,
});
const safeCount = (v: string | number | undefined): number => Number(v ?? 0);
const positiveInt = (
  value: number,
  name: string,
  max = Number.MAX_SAFE_INTEGER,
) => {
  if (!Number.isSafeInteger(value) || value < 1 || value > max)
    throw new Error(`${name} must be an integer between 1 and ${max}`);
  return value;
};

async function legacyCountsForSession(client: PoolClient, sessionId: string) {
  const result = await client.query<{
    summaries: string;
    entries: string;
    facts: string;
  }>(
    `SELECT
      (SELECT count(*) FROM scene_summaries s WHERE s.session_id=$1 AND NOT EXISTS (
        SELECT 1 FROM derived_memory_character_refs r WHERE r.session_id=s.session_id AND r.row_kind='scene_summary' AND r.row_id=s.id
      ))::text AS summaries,
      (SELECT count(*) FROM registry_entries e WHERE e.session_id=$1 AND NOT EXISTS (
        SELECT 1 FROM derived_memory_character_refs r WHERE r.session_id=e.session_id AND r.row_kind='registry_entry' AND r.row_id=e.id
      ))::text AS entries,
      (SELECT count(*) FROM registry_facts f JOIN registry_entries e ON e.id=f.entry_id WHERE e.session_id=$1 AND NOT EXISTS (
        SELECT 1 FROM derived_memory_character_refs r WHERE r.session_id=e.session_id AND r.row_kind='registry_entry' AND r.row_id=e.id
      ))::text AS facts`,
    [sessionId],
  );
  return {
    sceneSummaries: safeCount(result.rows[0]?.summaries),
    registryEntries: safeCount(result.rows[0]?.entries),
    registryFacts: safeCount(result.rows[0]?.facts),
  };
}

/** Read-only count pass; session ids are used internally and never leave this module or enter audit/logs. */
async function classifySessions(
  client: PoolClient,
): Promise<{ sessions: SessionRow[]; counts: LegacyClearCounts }> {
  const state = await client.query<{ complete: boolean }>(
    'SELECT complete FROM derived_memory_reconciliation_state WHERE singleton=true',
  );
  if (!state.rows[0])
    throw new Error(
      'Reference reconciliation state is missing; refusing legacy clear',
    );
  const result = await client.query<SessionRow>(
    `SELECT s.id::text AS session_id,
      EXISTS(SELECT 1 FROM legal_holds h WHERE h.kind='session' AND h.item_id=s.id::text) AS held,
      (NOT $1::boolean OR EXISTS(SELECT 1 FROM derived_memory_reconcile_skipped d WHERE d.session_id=s.id)) AS deferred
     FROM sessions s
     WHERE EXISTS(SELECT 1 FROM scene_summaries m WHERE m.session_id=s.id)
        OR EXISTS(SELECT 1 FROM registry_entries e WHERE e.session_id=s.id)
     ORDER BY s.id`,
    [state.rows[0].complete],
  );
  const counts = zeroCounts();
  const sessions: SessionRow[] = [];
  for (const row of result.rows) {
    if (row.held) {
      sessions.push({
        ...row,
        plannedSummaries: 0,
        plannedEntries: 0,
        plannedFacts: 0,
      });
      counts.sessionsSkippedHeld += 1;
    } else if (row.deferred) {
      sessions.push({
        ...row,
        plannedSummaries: 0,
        plannedEntries: 0,
        plannedFacts: 0,
      });
      counts.sessionsDeferred += 1;
    } else {
      counts.sessionsConsidered += 1;
      const rows = await legacyCountsForSession(client, row.session_id);
      counts.sceneSummaries += rows.sceneSummaries;
      counts.registryEntries += rows.registryEntries;
      counts.registryFacts += rows.registryFacts;
      sessions.push({
        ...row,
        plannedSummaries: rows.sceneSummaries,
        plannedEntries: rows.registryEntries,
        plannedFacts: rows.registryFacts,
      });
    }
  }
  return { sessions, counts };
}

function matchesCounts(
  a: LegacyClearCounts,
  b: LegacyClearCounts,
  tolerance: number,
) {
  return (Object.keys(a) as Array<keyof LegacyClearCounts>).every(
    (key) => Math.abs(a[key] - b[key]) <= tolerance,
  );
}

function emit(
  options: LegacyClearOptions,
  event: string,
  counts: LegacyClearCounts,
  outcome: string,
) {
  (
    options.log ??
    ((name, values, result) =>
      console.log(
        JSON.stringify({
          component: 'derived-memory-legacy-clear',
          event: name,
          mode: options.dryRun === false ? 'live' : 'dry_run',
          counts: values,
          outcome: result,
        }),
      ))
  )(event, counts, outcome);
}

async function saveAudit(
  client: PoolClient,
  runId: string,
  counts: Record<string, number>,
  outcome: string,
  finished: Date | null,
) {
  await client.query(
    'UPDATE derived_memory_legacy_clear_audit SET counts=$2::jsonb,outcome=$3,finished_at=$4 WHERE run_id=$1',
    [runId, JSON.stringify(counts), outcome, finished],
  );
}

/**
 * Separate operator-invoked one-time clear. It intentionally does not rebuild, re-screen, or touch indexed rows.
 * Defaults fail closed: disabled and dry-run.
 */
export async function runLegacyDerivedMemoryClear(
  pool: Pool,
  options: LegacyClearOptions = {},
): Promise<LegacyClearResult> {
  const enabled =
    options.enabled ??
    process.env.DERIVED_MEMORY_LEGACY_CLEAR_ENABLED === 'true';
  const dryRun =
    options.dryRun ??
    process.env.DERIVED_MEMORY_LEGACY_CLEAR_DRY_RUN !== 'false';
  const codeVersion =
    options.codeVersion ?? process.env.DERIVED_MEMORY_LEGACY_CLEAR_CODE_VERSION;
  if (!enabled)
    throw new Error(
      'Legacy derived-memory clear is disabled; set DERIVED_MEMORY_LEGACY_CLEAR_ENABLED=true explicitly',
    );
  if (
    !dryRun &&
    process.env.DERIVED_MEMORY_LEGACY_CLEAR_DRY_RUN === 'true' &&
    options.dryRun === undefined
  )
    throw new Error(
      'Live clear requires DERIVED_MEMORY_LEGACY_CLEAR_DRY_RUN=false',
    );
  if (!codeVersion)
    throw new Error('DERIVED_MEMORY_LEGACY_CLEAR_CODE_VERSION is required');
  const runner = await pool.connect();
  let lockHeld = false;
  let activeRunId: string | null = null;
  try {
    lockHeld = Boolean(
      (
        await runner.query<{ ok: boolean }>(
          'SELECT pg_try_advisory_lock($1) AS ok',
          [LEGACY_CLEAR_LOCK_KEY],
        )
      ).rows[0]?.ok,
    );
    if (!lockHeld)
      throw new Error(
        'Another legacy derived-memory clear runner holds the advisory lock',
      );
    const now = options.now ?? (() => new Date());
    const maxAge = positiveInt(
      options.dryRunMaxAgeMs ??
        Number(
          process.env.DERIVED_MEMORY_LEGACY_CLEAR_DRY_RUN_MAX_AGE_MS ??
            DEFAULT_DRY_RUN_MAX_AGE_MS,
        ),
      'dry-run maximum age',
    );
    const tolerance =
      options.countTolerance ??
      Number(process.env.DERIVED_MEMORY_LEGACY_CLEAR_COUNT_TOLERANCE ?? 0);
    if (!Number.isSafeInteger(tolerance) || tolerance < 0)
      throw new Error('count tolerance must be a non-negative integer');
    const batchSize = positiveInt(
      options.batchSize ??
        Number(
          process.env.DERIVED_MEMORY_LEGACY_CLEAR_BATCH_SIZE ??
            DEFAULT_BATCH_SIZE,
        ),
      'batch size',
      500,
    );
    const timeBudget = positiveInt(
      options.timeBudgetMs ??
        Number(
          process.env.DERIVED_MEMORY_LEGACY_CLEAR_TIME_BUDGET_MS ??
            DEFAULT_TIME_BUDGET_MS,
        ),
      'time budget',
    );
    const started = now();
    let runId: string = randomUUID();
    activeRunId = runId;
    await runner.query('BEGIN');
    const { sessions, counts } = await classifySessions(runner);
    let dryRunId: string | null = null;
    let resumeCounts: Record<string, number> | null = null;
    let removedSummaries = 0;
    let removedEntries = 0;
    let removedFacts = 0;
    let idempotentCompletion = false;
    if (!dryRun) {
      const resumable = await runner.query<AuditRow>(
        `SELECT run_id,dry_run_id,counts,finished_at,outcome FROM derived_memory_legacy_clear_audit
         WHERE mode='live' AND code_version=$1 AND outcome='live_partial'
           AND started_at >= $2::timestamptz - ($3::bigint * interval '1 millisecond')
         ORDER BY started_at DESC LIMIT 1`,
        [codeVersion, started, maxAge],
      );
      const resume = resumable.rows[0];
      if (resume?.dry_run_id) {
        const validDryRun = await runner.query(
          `SELECT 1 FROM derived_memory_legacy_clear_audit WHERE run_id=$1 AND mode='dry_run'
             AND code_version=$2 AND outcome='dry_run_succeeded'
             AND finished_at >= $3::timestamptz - ($4::bigint * interval '1 millisecond')`,
          [resume.dry_run_id, codeVersion, started, maxAge],
        );
        const oldCounts = resume.counts;
        removedSummaries = safeCount(oldCounts.sceneSummariesRemoved);
        removedEntries = safeCount(oldCounts.registryEntriesRemoved);
        removedFacts = safeCount(oldCounts.registryFactsRemoved);
        const plan: LegacyClearCounts = {
          sessionsConsidered: safeCount(oldCounts.sessionsConsidered),
          sessionsSkippedHeld: safeCount(oldCounts.sessionsSkippedHeld),
          sessionsDeferred: safeCount(oldCounts.sessionsDeferred),
          sceneSummaries: safeCount(oldCounts.sceneSummaries),
          registryEntries: safeCount(oldCounts.registryEntries),
          registryFacts: safeCount(oldCounts.registryFacts),
        };
        const resumedMatches =
          Boolean(validDryRun.rowCount) &&
          counts.sceneSummaries + removedSummaries === plan.sceneSummaries &&
          counts.registryEntries + removedEntries === plan.registryEntries &&
          counts.registryFacts + removedFacts === plan.registryFacts &&
          counts.sessionsSkippedHeld === plan.sessionsSkippedHeld &&
          counts.sessionsDeferred === plan.sessionsDeferred;
        if (!resumedMatches) {
          await runner.query('ROLLBACK');
          throw new Error(
            'Resumed live counts no longer match the original dry run; refusing to continue',
          );
        }
        runId = resume.run_id;
        activeRunId = runId;
        dryRunId = resume.dry_run_id;
        resumeCounts = {
          ...plan,
          sessionsProcessed: safeCount(oldCounts.sessionsProcessed),
          sceneSummariesRemoved: removedSummaries,
          registryEntriesRemoved: removedEntries,
          registryFactsRemoved: removedFacts,
        };
      } else {
        const previous = await runner.query<AuditRow>(
          `SELECT run_id,counts,finished_at,outcome FROM derived_memory_legacy_clear_audit
           WHERE mode='dry_run' AND code_version=$1 AND outcome='dry_run_succeeded'
             AND finished_at >= $2::timestamptz - ($3::bigint * interval '1 millisecond')
           ORDER BY finished_at DESC LIMIT 1`,
          [codeVersion, started, maxAge],
        );
        const dry = previous.rows[0];
        dryRunId = dry?.run_id ?? null;
        const priorCounts = dry?.counts;
        if (
          dryRunId &&
          priorCounts &&
          !matchesCounts(counts, priorCounts, tolerance)
        ) {
          const earlierLive = await runner.query(
            `SELECT 1 FROM derived_memory_legacy_clear_audit WHERE mode='live' AND dry_run_id=$1 AND outcome='live_succeeded' LIMIT 1`,
            [dryRunId],
          );
          idempotentCompletion =
            counts.sceneSummaries === 0 &&
            counts.registryEntries === 0 &&
            counts.registryFacts === 0 &&
            counts.sessionsSkippedHeld === priorCounts.sessionsSkippedHeld &&
            counts.sessionsDeferred === priorCounts.sessionsDeferred &&
            Boolean(earlierLive.rowCount);
        }
        if (
          !dryRunId ||
          !priorCounts ||
          (!matchesCounts(counts, priorCounts, tolerance) &&
            !idempotentCompletion)
        ) {
          await runner.query(
            `INSERT INTO derived_memory_legacy_clear_audit(run_id,mode,code_version,dry_run_id,counts,outcome,started_at,finished_at)
             VALUES($1,'live',$2,$3,$4::jsonb,'aborted',$5,$5)`,
            [runId, codeVersion, dryRunId, JSON.stringify(counts), started],
          );
          await runner.query('COMMIT');
          emit(options, 'legacy_clear_live_aborted', counts, 'aborted');
          throw new Error(
            'Live clear requires a recent matching successful dry run for the same code version; counts must match within configured tolerance',
          );
        }
      }
    }
    if (!resumeCounts) {
      const initialAuditCounts = dryRun
        ? counts
        : {
            ...counts,
            sessionsProcessed: 0,
            sceneSummariesRemoved: 0,
            registryEntriesRemoved: 0,
            registryFactsRemoved: 0,
          };
      await runner.query(
        `INSERT INTO derived_memory_legacy_clear_audit(run_id,mode,code_version,dry_run_id,counts,outcome,started_at)
         VALUES($1,$2,$3,$4,$5::jsonb,'running',$6)`,
        [
          runId,
          dryRun ? 'dry_run' : 'live',
          codeVersion,
          dryRunId,
          JSON.stringify(initialAuditCounts),
          started,
        ],
      );
    }
    await runner.query('COMMIT');
    emit(
      options,
      dryRun ? 'legacy_clear_dry_run_started' : 'legacy_clear_live_started',
      counts,
      'running',
    );
    let outcome: LegacyClearOutcome;
    if (dryRun) {
      outcome = 'dry_run_succeeded';
    } else {
      let processed = resumeCounts?.sessionsProcessed ?? 0;
      let processedThisPass = 0;
      let newlyHeld = 0;
      removedSummaries = resumeCounts?.sceneSummariesRemoved ?? 0;
      removedEntries = resumeCounts?.registryEntriesRemoved ?? 0;
      removedFacts = resumeCounts?.registryFactsRemoved ?? 0;
      for (const session of sessions) {
        if (session.held || session.deferred) continue;
        if (
          processedThisPass > 0 &&
          processedThisPass % batchSize === 0 &&
          now().getTime() - started.getTime() >= timeBudget
        )
          break;
        await runner.query('BEGIN');
        try {
          const locked = await runner.query(
            'SELECT id FROM sessions WHERE id=$1 FOR UPDATE',
            [session.session_id],
          );
          if (!locked.rowCount) {
            await runner.query('COMMIT');
            processed += 1;
            processedThisPass += 1;
            continue;
          }
          const held = await runner.query(
            "SELECT 1 FROM legal_holds WHERE kind='session' AND item_id=$1",
            [session.session_id],
          );
          if (held.rowCount) {
            await runner.query('COMMIT');
            newlyHeld += 1;
            processed += 1;
            processedThisPass += 1;
            continue;
          }
          const state = await runner.query<{ complete: boolean }>(
            'SELECT complete FROM derived_memory_reconciliation_state WHERE singleton=true',
          );
          const deferred = await runner.query(
            'SELECT 1 FROM derived_memory_reconcile_skipped WHERE session_id=$1',
            [session.session_id],
          );
          if (!state.rows[0]?.complete || deferred.rowCount)
            throw new Error(
              'Coverage state changed after live preflight; aborting without processing this session',
            );
          const before = await legacyCountsForSession(
            runner,
            session.session_id,
          );
          if (
            before.sceneSummaries !== session.plannedSummaries ||
            before.registryEntries !== session.plannedEntries ||
            before.registryFacts !== session.plannedFacts
          )
            throw new Error(
              'Session row counts changed after live preflight; refusing to delete rows not included in the verified counts',
            );
          await runner.query(
            `DELETE FROM registry_entries e WHERE e.session_id=$1 AND NOT EXISTS (
            SELECT 1 FROM derived_memory_character_refs r WHERE r.session_id=e.session_id AND r.row_kind='registry_entry' AND r.row_id=e.id)`,
            [session.session_id],
          );
          await runner.query(
            `DELETE FROM scene_summaries s WHERE s.session_id=$1 AND NOT EXISTS (
            SELECT 1 FROM derived_memory_character_refs r WHERE r.session_id=s.session_id AND r.row_kind='scene_summary' AND r.row_id=s.id)`,
            [session.session_id],
          );
          removedSummaries += before.sceneSummaries;
          removedEntries += before.registryEntries;
          removedFacts += before.registryFacts;
          await runner.query('COMMIT');
        } catch (error) {
          await runner.query('ROLLBACK');
          throw error;
        }
        processed += 1;
        processedThisPass += 1;
      }
      const partial =
        processedThisPass <
        sessions.filter((s) => !s.held && !s.deferred).length;
      outcome = partial ? 'live_partial' : 'live_succeeded';
      const actualCounts = {
        ...counts,
        sessionsSkippedHeld: counts.sessionsSkippedHeld + newlyHeld,
        sceneSummaries: removedSummaries,
        registryEntries: removedEntries,
        registryFacts: removedFacts,
      };
      const auditCounts = {
        ...(resumeCounts ?? counts),
        sessionsSkippedHeld: counts.sessionsSkippedHeld + newlyHeld,
        sessionsProcessed: processed,
        sceneSummariesRemoved: removedSummaries,
        registryEntriesRemoved: removedEntries,
        registryFactsRemoved: removedFacts,
      };
      await runner.query('BEGIN');
      await saveAudit(runner, runId, auditCounts, outcome, now());
      await runner.query('COMMIT');
      emit(
        options,
        partial
          ? 'legacy_clear_live_batch_completed'
          : 'legacy_clear_live_completed',
        actualCounts,
        outcome,
      );
      return { runId, dryRunId, outcome, counts: actualCounts };
    }
    await runner.query('BEGIN');
    await saveAudit(runner, runId, counts, outcome, now());
    await runner.query('COMMIT');
    emit(options, 'legacy_clear_dry_run_completed', counts, outcome);
    return { runId, dryRunId, outcome, counts };
  } catch (error) {
    try {
      await runner.query('ROLLBACK');
    } catch {
      /* transaction may already be closed */
    }
    if (activeRunId) {
      try {
        await runner.query(
          "UPDATE derived_memory_legacy_clear_audit SET outcome='failed',finished_at=now() WHERE run_id=$1 AND outcome IN ('running','live_partial')",
          [activeRunId],
        );
      } catch {
        /* audit table may not exist, or preflight may not have inserted a run */
      }
    }
    throw error;
  } finally {
    if (lockHeld)
      await runner.query('SELECT pg_advisory_unlock($1)', [
        LEGACY_CLEAR_LOCK_KEY,
      ]);
    runner.release();
  }
}
