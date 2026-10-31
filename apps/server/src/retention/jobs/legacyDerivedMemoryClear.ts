import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { hasLegalHold } from '../types.js';

const LEGACY_CLEAR_LOCK_KEY = 7_201_939;
const DEFAULT_DRY_RUN_MAX_AGE_MS = 24 * 60 * 60_000;
const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_TIME_BUDGET_MS = 2_000;
const DEFAULT_SESSION_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_RUNNING_STALE_AFTER_MS = 15 * 60_000;

export type LegacyClearCounts = {
  sessionsConsidered: number;
  sessionsSkippedHeld: number;
  sessionsDeferred: number;
  sessionsDeferredChain: number;
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
  sessionLockTimeoutMs?: number;
  runningStaleAfterMs?: number;
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
  sessionsDeferredChain: 0,
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
         SELECT 1 FROM derived_memory_character_refs r WHERE r.row_kind='registry_entry' AND r.row_id=e.id
       ))::text AS entries,
       (SELECT count(*) FROM registry_facts f JOIN registry_entries e ON e.id=f.entry_id
         WHERE e.session_id=$1 AND NOT EXISTS (
           SELECT 1 FROM derived_memory_character_refs r WHERE r.row_kind='registry_entry' AND r.row_id=e.id
         ))::text AS facts`,
    [sessionId],
  );
  return {
    sceneSummaries: safeCount(result.rows[0]?.summaries),
    registryEntries: safeCount(result.rows[0]?.entries),
    registryFacts: safeCount(result.rows[0]?.facts),
  };
}

async function sessionIsHeld(
  client: PoolClient,
  sessionId: string,
  ownerId: string,
) {
  if (await hasLegalHold(client, 'session', sessionId)) return true;
  const seatAccounts = await client.query<{ account_id: string }>(
    'SELECT DISTINCT account_id::text FROM session_seat_characters WHERE session_id=$1 AND account_id IS NOT NULL',
    [sessionId],
  );
  const accountIds = new Set([
    ownerId,
    ...seatAccounts.rows.map((r) => r.account_id),
  ]);
  for (const accountId of accountIds) {
    if (await hasLegalHold(client, 'account', accountId)) return true;
  }
  const exports = await client.query<{ id: string }>(
    'SELECT id::text FROM export_jobs WHERE account_id=ANY($1::uuid[])',
    [[...accountIds]],
  );
  for (const exp of exports.rows) {
    if (await hasLegalHold(client, 'export', exp.id)) return true;
  }
  return false;
}

/** Count-only classification; ids stay inside this module and never enter logs/audit. */
async function classifySessions(client: PoolClient): Promise<{
  sessions: SessionRow[];
  counts: LegacyClearCounts;
  reconciliationComplete: boolean;
}> {
  const state = await client.query<{ complete: boolean }>(
    'SELECT complete FROM derived_memory_reconciliation_state WHERE singleton=true',
  );
  if (!state.rows[0])
    throw new Error(
      'Reference reconciliation state is missing; refusing legacy clear',
    );
  const result = await client.query<{
    session_id: string;
    owner_account_id: string;
  }>(
    `SELECT s.id::text AS session_id,s.owner_account_id::text AS owner_account_id
       FROM sessions s
      WHERE EXISTS(SELECT 1 FROM scene_summaries m WHERE m.session_id=s.id)
         OR EXISTS(SELECT 1 FROM registry_entries e WHERE e.session_id=s.id)
      ORDER BY s.id`,
  );
  const counts = zeroCounts();
  const sessions: SessionRow[] = [];
  for (const row of result.rows) {
    const held = await sessionIsHeld(
      client,
      row.session_id,
      row.owner_account_id,
    );
    const skipped = await client.query(
      'SELECT 1 FROM derived_memory_reconcile_skipped WHERE session_id=$1',
      [row.session_id],
    );
    const deferred = !state.rows[0].complete || Boolean(skipped.rowCount);
    const hasSupersessionLink = Boolean(
      (
        await client.query(
          'SELECT 1 FROM registry_entries WHERE session_id=$1 AND (supersedes_id IS NOT NULL OR superseded_by IS NOT NULL) LIMIT 1',
          [row.session_id],
        )
      ).rowCount,
    );
    if (held) {
      counts.sessionsSkippedHeld += 1;
      sessions.push({
        session_id: row.session_id,
        held,
        deferred: false,
        plannedSummaries: 0,
        plannedEntries: 0,
        plannedFacts: 0,
      });
    } else if (deferred || hasSupersessionLink) {
      counts.sessionsDeferred += 1;
      if (hasSupersessionLink) counts.sessionsDeferredChain += 1;
      sessions.push({
        session_id: row.session_id,
        held,
        deferred: deferred || hasSupersessionLink,
        plannedSummaries: 0,
        plannedEntries: 0,
        plannedFacts: 0,
      });
    } else {
      counts.sessionsConsidered += 1;
      const rows = await legacyCountsForSession(client, row.session_id);
      counts.sceneSummaries += rows.sceneSummaries;
      counts.registryEntries += rows.registryEntries;
      counts.registryFacts += rows.registryFacts;
      sessions.push({
        session_id: row.session_id,
        held,
        deferred,
        plannedSummaries: rows.sceneSummaries,
        plannedEntries: rows.registryEntries,
        plannedFacts: rows.registryFacts,
      });
    }
  }
  return { sessions, counts, reconciliationComplete: state.rows[0].complete };
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
    'UPDATE derived_memory_legacy_clear_audit SET counts=$2::jsonb,outcome=$3,finished_at=$4,heartbeat_at=now() WHERE run_id=$1',
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
  if (!codeVersion)
    throw new Error('DERIVED_MEMORY_LEGACY_CLEAR_CODE_VERSION is required');
  const attestationText =
    process.env.DERIVED_MEMORY_LEGACY_CLEAR_BACKUP_CONFIRMED_AT;
  let backupConfirmedAt: Date | null = null;
  if (!dryRun) {
    const parsed = attestationText ? new Date(attestationText) : null;
    const nowMs = (options.now ?? (() => new Date()))().getTime();
    if (
      parsed &&
      Number.isFinite(parsed.getTime()) &&
      parsed.toISOString() === attestationText &&
      parsed.getTime() <= nowMs &&
      nowMs - parsed.getTime() <= 24 * 60 * 60_000
    )
      backupConfirmedAt = parsed;
  }
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
    const staleAfter = positiveInt(
      options.runningStaleAfterMs ??
        Number(
          process.env.DERIVED_MEMORY_LEGACY_CLEAR_RUNNING_STALE_AFTER_MS ??
            DEFAULT_RUNNING_STALE_AFTER_MS,
        ),
      'running audit staleness window',
    );
    await runner.query(
      "UPDATE derived_memory_legacy_clear_audit SET outcome='failed',reason_code='process_died',finished_at=now() WHERE mode='live' AND outcome='running' AND heartbeat_at < now() - ($1::bigint * interval '1 millisecond')",
      [staleAfter],
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
    const sessionLockTimeout = positiveInt(
      options.sessionLockTimeoutMs ??
        Number(
          process.env.DERIVED_MEMORY_LEGACY_CLEAR_LOCK_TIMEOUT_MS ??
            DEFAULT_SESSION_LOCK_TIMEOUT_MS,
        ),
      'session lock timeout',
    );
    const started = now();
    let runId: string = randomUUID();
    activeRunId = runId;
    await runner.query('BEGIN');
    const { sessions, counts, reconciliationComplete } =
      await classifySessions(runner);
    if (!dryRun && !backupConfirmedAt) {
      await runner.query(
        `INSERT INTO derived_memory_legacy_clear_audit(run_id,mode,code_version,counts,outcome,started_at,finished_at,reason_code)
         VALUES($1,'live',$2,$3::jsonb,'aborted',$4,$4,'backup_not_confirmed')`,
        [runId, codeVersion, JSON.stringify(counts), started],
      );
      await runner.query('COMMIT');
      throw new Error(
        'Live clear requires a valid backup attestation from the last 24 hours',
      );
    }
    let dryRunId: string | null = null;
    let resumeCounts: Record<string, number> | null = null;
    let removedSummaries = 0;
    let removedEntries = 0;
    let removedFacts = 0;
    let idempotentCompletion = false;
    if (!dryRun && !reconciliationComplete) {
      await runner.query(
        `INSERT INTO derived_memory_legacy_clear_audit(run_id,mode,code_version,counts,outcome,started_at,finished_at,reason_code)
         VALUES($1,'live',$2,$3::jsonb,'aborted',$4,$4,'global_reconciliation_incomplete')`,
        [runId, codeVersion, JSON.stringify(counts), started],
      );
      await runner.query(
        'UPDATE derived_memory_legacy_clear_audit SET backup_confirmed_at=$2 WHERE run_id=$1',
        [runId, backupConfirmedAt],
      );
      await runner.query('COMMIT');
      emit(options, 'legacy_clear_live_aborted', counts, 'aborted');
      throw new Error(
        'Live clear requires global reference reconciliation to be complete; refusing to report success while coverage is unverified',
      );
    }
    if (!dryRun) {
      const resumable = await runner.query<AuditRow>(
        `SELECT run_id,dry_run_id,counts,finished_at,outcome FROM derived_memory_legacy_clear_audit
         WHERE mode='live' AND code_version=$1 AND outcome IN ('live_partial','failed')
           AND (outcome='live_partial' OR reason_code='process_died')
           AND started_at >= $2::timestamptz - ($3::bigint * interval '1 millisecond')
         ORDER BY started_at DESC LIMIT 1`,
        [codeVersion, started, maxAge],
      );
      const resume = resumable.rows[0];
      if (resume?.dry_run_id) {
        const validDryRun = await runner.query<{ counts: LegacyClearCounts }>(
          `SELECT counts FROM derived_memory_legacy_clear_audit WHERE run_id=$1 AND mode='dry_run'
             AND code_version=$2 AND outcome='dry_run_succeeded'
             AND finished_at >= $3::timestamptz - ($4::bigint * interval '1 millisecond')`,
          [resume.dry_run_id, codeVersion, started, maxAge],
        );
        const oldCounts = resume.counts;
        const dryPlan = validDryRun.rows[0]?.counts;
        removedSummaries = safeCount(oldCounts.sceneSummariesRemoved);
        removedEntries = safeCount(oldCounts.registryEntriesRemoved);
        removedFacts = safeCount(oldCounts.registryFactsRemoved);
        const plan: LegacyClearCounts = {
          sessionsConsidered: safeCount(dryPlan?.sessionsConsidered),
          sessionsSkippedHeld: safeCount(dryPlan?.sessionsSkippedHeld),
          sessionsDeferred: safeCount(dryPlan?.sessionsDeferred),
          sessionsDeferredChain: safeCount(dryPlan?.sessionsDeferredChain),
          sceneSummaries: safeCount(dryPlan?.sceneSummaries),
          registryEntries: safeCount(dryPlan?.registryEntries),
          registryFacts: safeCount(dryPlan?.registryFacts),
        };
        const resumedMatches =
          Boolean(validDryRun.rowCount) &&
          counts.sceneSummaries + removedSummaries === plan.sceneSummaries &&
          counts.registryEntries + removedEntries === plan.registryEntries &&
          counts.registryFacts + removedFacts === plan.registryFacts &&
          counts.sessionsSkippedHeld === plan.sessionsSkippedHeld &&
          counts.sessionsDeferred === plan.sessionsDeferred &&
          counts.sessionsDeferredChain === plan.sessionsDeferredChain;
        if (!resumedMatches) {
          await runner.query('ROLLBACK');
          await runner.query('BEGIN');
          await runner.query(
            `INSERT INTO derived_memory_legacy_clear_audit(run_id,mode,code_version,dry_run_id,counts,outcome,started_at,finished_at,reason_code)
             VALUES($1,'live',$2,$3,$4::jsonb,'aborted',$5,$5,'resume_count_mismatch')`,
            [
              runId,
              codeVersion,
              resume.dry_run_id,
              JSON.stringify(counts),
              started,
            ],
          );
          if (backupConfirmedAt)
            await runner.query(
              'UPDATE derived_memory_legacy_clear_audit SET backup_confirmed_at=$2 WHERE run_id=$1',
              [runId, backupConfirmedAt],
            );
          await runner.query('COMMIT');
          emit(options, 'legacy_clear_live_aborted', counts, 'aborted');
          throw new Error(
            'Resumed live candidate counts no longer equal the original dry-run plan; refusing to continue',
          );
        }
        runId = resume.run_id;
        activeRunId = runId;
        dryRunId = resume.dry_run_id;
        await runner.query(
          "UPDATE derived_memory_legacy_clear_audit SET outcome='running',finished_at=NULL,heartbeat_at=now() WHERE run_id=$1",
          [runId],
        );
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
            `INSERT INTO derived_memory_legacy_clear_audit(run_id,mode,code_version,dry_run_id,counts,outcome,started_at,finished_at,reason_code)
             VALUES($1,'live',$2,$3,$4::jsonb,'aborted',$5,$5,'dry_run_count_mismatch')`,
            [runId, codeVersion, dryRunId, JSON.stringify(counts), started],
          );
          if (backupConfirmedAt)
            await runner.query(
              'UPDATE derived_memory_legacy_clear_audit SET backup_confirmed_at=$2 WHERE run_id=$1',
              [runId, backupConfirmedAt],
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
      if (backupConfirmedAt)
        await runner.query(
          'UPDATE derived_memory_legacy_clear_audit SET backup_confirmed_at=$2 WHERE run_id=$1',
          [runId, backupConfirmedAt],
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
      const persistBatchProgress = async () => {
        processed += 1;
        processedThisPass += 1;
        const progressCounts = {
          ...(resumeCounts ?? counts),
          sessionsSkippedHeld: counts.sessionsSkippedHeld + newlyHeld,
          sessionsProcessed: processed,
          sceneSummariesRemoved: removedSummaries,
          registryEntriesRemoved: removedEntries,
          registryFactsRemoved: removedFacts,
        };
        await runner.query(
          'UPDATE derived_memory_legacy_clear_audit SET counts=$2::jsonb,heartbeat_at=now() WHERE run_id=$1',
          [runId, JSON.stringify(progressCounts)],
        );
        await runner.query('COMMIT');
      };
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
          await runner.query("SELECT set_config('lock_timeout',$1,true)", [
            `${sessionLockTimeout}ms`,
          ]);
          const locked = await runner.query(
            'SELECT id FROM sessions WHERE id=$1 FOR UPDATE',
            [session.session_id],
          );
          if (!locked.rowCount) {
            await persistBatchProgress();
            emit(
              options,
              'legacy_clear_live_batch_committed',
              counts,
              'running',
            );
            continue;
          }
          const owner = await runner.query<{ owner_account_id: string }>(
            'SELECT owner_account_id::text FROM sessions WHERE id=$1',
            [session.session_id],
          );
          if (
            owner.rows[0] &&
            (await sessionIsHeld(
              runner,
              session.session_id,
              owner.rows[0].owner_account_id,
            ))
          ) {
            newlyHeld += 1;
            await persistBatchProgress();
            emit(
              options,
              'legacy_clear_live_batch_committed',
              {
                ...counts,
                sessionsSkippedHeld: counts.sessionsSkippedHeld + newlyHeld,
              },
              'running',
            );
            continue;
          }
          const state = await runner.query<{ complete: boolean }>(
            'SELECT complete FROM derived_memory_reconciliation_state WHERE singleton=true',
          );
          const deferred = await runner.query(
            `SELECT 1 WHERE EXISTS(SELECT 1 FROM derived_memory_reconcile_skipped WHERE session_id=$1)`,
            [session.session_id],
          );
          if (!state.rows[0]?.complete || deferred.rowCount)
            throw new Error(
              'Coverage state changed after live preflight; aborting without processing this session',
            );
          const chain = await runner.query(
            'SELECT 1 FROM registry_entries WHERE session_id=$1 AND (supersedes_id IS NOT NULL OR superseded_by IS NOT NULL) LIMIT 1',
            [session.session_id],
          );
          if (chain.rowCount)
            throw new Error(
              'Supersession chain appeared after live preflight; refusing to process the session',
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
          const candidates = await runner.query<{ id: string }>(
            `WITH RECURSIVE entries AS (
               SELECT e.id,e.supersedes_id,e.superseded_by,EXISTS(SELECT 1 FROM derived_memory_character_refs r WHERE r.row_kind='registry_entry' AND r.row_id=e.id) covered
                 FROM registry_entries e WHERE e.session_id=$1
             ), protected(id) AS (
               SELECT id FROM entries WHERE covered UNION SELECT e.id FROM entries e JOIN protected p ON e.supersedes_id=p.id OR e.superseded_by=p.id
             ), candidate(id) AS (SELECT id FROM entries WHERE NOT covered AND id NOT IN (SELECT id FROM protected))
             SELECT c.id::text FROM candidate c JOIN registry_entries e ON e.id=c.id ORDER BY e.version DESC,e.id DESC`,
            [session.session_id],
          );
          await runner.query(
            `UPDATE registry_facts SET supersedes_id=NULL,superseded_by=NULL WHERE entry_id=ANY($1::bigint[])`,
            [candidates.rows.map((row) => row.id)],
          );
          await runner.query(
            `UPDATE registry_entries SET superseded_by=NULL WHERE id=ANY($1::bigint[])`,
            [candidates.rows.map((row) => row.id)],
          );
          for (const candidate of candidates.rows) {
            await runner.query('DELETE FROM registry_entries WHERE id=$1', [
              candidate.id,
            ]);
          }
          await runner.query(
            `DELETE FROM scene_summaries s WHERE s.session_id=$1 AND NOT EXISTS (
            SELECT 1 FROM derived_memory_character_refs r WHERE r.session_id=s.session_id AND r.row_kind='scene_summary' AND r.row_id=s.id)`,
            [session.session_id],
          );
          removedSummaries += before.sceneSummaries;
          removedEntries += before.registryEntries;
          removedFacts += before.registryFacts;
          await persistBatchProgress();
        } catch (error) {
          await runner.query('ROLLBACK');
          throw error;
        }
        emit(
          options,
          'legacy_clear_live_batch_committed',
          {
            ...counts,
            sessionsSkippedHeld: counts.sessionsSkippedHeld + newlyHeld,
            sceneSummaries: removedSummaries,
            registryEntries: removedEntries,
            registryFacts: removedFacts,
          },
          'running',
        );
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
