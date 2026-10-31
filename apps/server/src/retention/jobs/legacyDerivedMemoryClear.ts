import { createHash, randomUUID } from 'node:crypto';
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
  batchSize?: number;
  timeBudgetMs?: number;
  sessionLockTimeoutMs?: number;
  runningStaleAfterMs?: number;
  /** Test seams; CLI never supplies these. */
  heartbeatIntervalMsForTests?: number;
  beforeSessionLockForTests?: (
    sessionId: string,
    index: number,
  ) => Promise<void>;
  afterSessionIdentityCheckForTests?: (
    client: PoolClient,
    sessionId: string,
  ) => Promise<void>;
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
  plannedSummaryIds: string[];
  plannedEntryIds: string[];
  plannedFactIds: string[];
};
type AuditRow = {
  run_id: string;
  dry_run_id?: string | null;
  counts: LegacyClearCounts & Record<string, number>;
  finished_at: Date | null;
  outcome: string;
};
type PlanRow = CandidateIds & {
  dry_run_id: string;
  session_id: string;
  digest: string;
  counts: {
    sceneSummaries: number;
    registryEntries: number;
    registryFacts: number;
  };
  state: 'pending' | 'done';
};

class PlanDigestMismatchError extends Error {
  constructor() {
    super(
      'plan_digest_mismatch: candidate row identities changed; take a fresh dry run',
    );
    this.name = 'PlanDigestMismatchError';
  }
}

async function readPlanRows(
  client: PoolClient,
  dryRunId: string,
): Promise<PlanRow[]> {
  const result = await client.query<{
    dry_run_id: string;
    session_id: string;
    digest: string;
    counts: PlanRow['counts'];
    scene_summary_ids: string[];
    registry_entry_ids: string[];
    registry_fact_ids: string[];
    state: 'pending' | 'done';
  }>(
    `SELECT dry_run_id::text,session_id::text,digest,counts,
            scene_summary_ids::text[],registry_entry_ids::text[],registry_fact_ids::text[],state
       FROM derived_memory_legacy_clear_plan WHERE dry_run_id=$1 ORDER BY session_id`,
    [dryRunId],
  );
  return result.rows.map((row) => ({
    dry_run_id: row.dry_run_id,
    session_id: row.session_id,
    digest: row.digest,
    counts: row.counts,
    sceneSummaryIds: row.scene_summary_ids,
    registryEntryIds: row.registry_entry_ids,
    registryFactIds: row.registry_fact_ids,
    state: row.state,
  }));
}

async function purgePlan(client: PoolClient, dryRunId: string): Promise<void> {
  await client.query(
    'DELETE FROM derived_memory_legacy_clear_plan WHERE dry_run_id=$1',
    [dryRunId],
  );
  await client.query(
    'DELETE FROM derived_memory_legacy_clear_plan_runs WHERE dry_run_id=$1',
    [dryRunId],
  );
}

async function planMatchesCurrent(
  client: PoolClient,
  dryRunId: string,
  sessions: SessionRow[],
): Promise<{ matches: boolean; markerExists: boolean; rows: PlanRow[] }> {
  const marker = await client.query(
    'SELECT 1 FROM derived_memory_legacy_clear_plan_runs WHERE dry_run_id=$1',
    [dryRunId],
  );
  if (!marker.rowCount)
    return { matches: false, markerExists: false, rows: [] };
  const rows = await readPlanRows(client, dryRunId);
  const currentBySession = new Map(
    sessions.map((session) => [session.session_id, session]),
  );
  const plansBySession = new Map(rows.map((row) => [row.session_id, row]));
  for (const session of sessions) {
    if (
      !session.held &&
      !session.deferred &&
      !plansBySession.has(session.session_id)
    )
      return { matches: false, markerExists: true, rows };
  }
  for (const plan of rows) {
    const current = currentBySession.get(plan.session_id);
    if (current?.deferred) return { matches: false, markerExists: true, rows };
    const ids =
      current && !current.held
        ? {
            sceneSummaryIds: current.plannedSummaryIds,
            registryEntryIds: current.plannedEntryIds,
            registryFactIds: current.plannedFactIds,
          }
        : await candidateIdsForSession(client, plan.session_id);
    if (plan.state === 'done') {
      if (
        ids.sceneSummaryIds.length ||
        ids.registryEntryIds.length ||
        ids.registryFactIds.length
      )
        return { matches: false, markerExists: true, rows };
      continue;
    }
    if (
      planDigest(plan.session_id, ids) !== plan.digest ||
      plan.counts.sceneSummaries !== plan.sceneSummaryIds.length ||
      plan.counts.registryEntries !== plan.registryEntryIds.length ||
      plan.counts.registryFacts !== plan.registryFactIds.length
    )
      return { matches: false, markerExists: true, rows };
  }
  return { matches: true, markerExists: true, rows };
}
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

type CandidateIds = {
  sceneSummaryIds: string[];
  registryEntryIds: string[];
  registryFactIds: string[];
};

function planDigest(sessionId: string, ids: CandidateIds): string {
  const normalized = {
    sessionId,
    sceneSummaryIds: [...ids.sceneSummaryIds].sort((a, b) =>
      BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0,
    ),
    registryEntryIds: [...ids.registryEntryIds].sort((a, b) =>
      BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0,
    ),
    registryFactIds: [...ids.registryFactIds].sort((a, b) =>
      BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0,
    ),
  };
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

async function candidateIdsForSession(
  client: PoolClient,
  sessionId: string,
): Promise<CandidateIds> {
  const summaries = await client.query<{ id: string }>(
    `SELECT s.id::text AS id FROM scene_summaries s
      WHERE s.session_id=$1 AND NOT EXISTS (
        SELECT 1 FROM derived_memory_character_refs r
         WHERE r.session_id=s.session_id AND r.row_kind='scene_summary' AND r.row_id=s.id
      ) ORDER BY s.id`,
    [sessionId],
  );
  const entries = await client.query<{ id: string }>(
    `SELECT e.id::text AS id FROM registry_entries e
      WHERE e.session_id=$1 AND NOT EXISTS (
        SELECT 1 FROM derived_memory_character_refs r
         WHERE r.row_kind='registry_entry' AND r.row_id=e.id
      ) ORDER BY e.id`,
    [sessionId],
  );
  const facts = await client.query<{ id: string }>(
    `SELECT f.id::text AS id FROM registry_facts f
       JOIN registry_entries e ON e.id=f.entry_id
      WHERE e.session_id=$1 AND NOT EXISTS (
        SELECT 1 FROM derived_memory_character_refs r
         WHERE r.row_kind='registry_entry' AND r.row_id=e.id
      ) ORDER BY f.id`,
    [sessionId],
  );
  return {
    sceneSummaryIds: summaries.rows.map((row) => row.id),
    registryEntryIds: entries.rows.map((row) => row.id),
    registryFactIds: facts.rows.map((row) => row.id),
  };
}

function candidateCounts(ids: CandidateIds) {
  return {
    sceneSummaries: ids.sceneSummaryIds.length,
    registryEntries: ids.registryEntryIds.length,
    registryFacts: ids.registryFactIds.length,
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
        plannedSummaryIds: [],
        plannedEntryIds: [],
        plannedFactIds: [],
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
        plannedSummaryIds: [],
        plannedEntryIds: [],
        plannedFactIds: [],
      });
    } else {
      counts.sessionsConsidered += 1;
      const ids = await candidateIdsForSession(client, row.session_id);
      const rows = candidateCounts(ids);
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
        plannedSummaryIds: ids.sceneSummaryIds,
        plannedEntryIds: ids.registryEntryIds,
        plannedFactIds: ids.registryFactIds,
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
) {
  await client.query(
    "UPDATE derived_memory_legacy_clear_audit SET counts=$2::jsonb,outcome=$3,reason_code=CASE WHEN $3='live_succeeded' THEN NULL ELSE reason_code END,finished_at=CASE WHEN $3 IN ('live_succeeded','live_partial','dry_run_succeeded') THEN clock_timestamp() ELSE finished_at END,heartbeat_at=clock_timestamp() WHERE run_id=$1",
    [runId, JSON.stringify(counts), outcome],
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
    if (
      parsed &&
      Number.isFinite(parsed.getTime()) &&
      parsed.toISOString() === attestationText
    )
      backupConfirmedAt = parsed;
  }
  const runner = await pool.connect();
  let lockHeld = false;
  let activeRunId: string | null = null;
  let activeDryRunId: string | null = null;
  let activePlanRows: PlanRow[] = [];
  let heartbeatClient: PoolClient | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  const heartbeatState: { pending: Promise<void> | null } = { pending: null };
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
        'A legacy derived-memory clear runner (or a just-killed runner finishing its in-flight statement) holds the advisory lock; retry in a few seconds',
      );
    const staleAfter = positiveInt(
      options.runningStaleAfterMs ??
        Number(
          process.env.DERIVED_MEMORY_LEGACY_CLEAR_RUNNING_STALE_AFTER_MS ??
            DEFAULT_RUNNING_STALE_AFTER_MS,
        ),
      'running audit staleness window',
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
    const tolerance = 0;
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
    const startedAt = await runner.query<{ now: Date }>(
      'SELECT clock_timestamp() AS now',
    );
    const started = startedAt.rows[0]!.now;
    const newestDry = !dryRun
      ? await runner.query<{ run_id: string }>(
          `SELECT run_id FROM derived_memory_legacy_clear_audit
           WHERE mode='dry_run' AND code_version=$1 AND outcome='dry_run_succeeded'
             AND finished_at >= $2::timestamptz - ($3::bigint * interval '1 millisecond')
           ORDER BY finished_at DESC LIMIT 1`,
          [codeVersion, started, maxAge],
        )
      : null;
    let dryRunId: string | null = newestDry?.rows[0]?.run_id ?? null;
    activeDryRunId = dryRunId;
    await runner.query('BEGIN');
    await runner.query(
      "UPDATE derived_memory_legacy_clear_audit SET outcome='failed',reason_code='process_died',finished_at=clock_timestamp() WHERE mode='live' AND outcome='running' AND heartbeat_at < clock_timestamp() - ($1::bigint * interval '1 millisecond')",
      [staleAfter],
    );
    const expiredPlans = await runner.query<{ dry_run_id: string }>(
      `SELECT DISTINCT ids.dry_run_id::text
       FROM (
         SELECT dry_run_id FROM derived_memory_legacy_clear_plan_runs
         UNION
         SELECT dry_run_id FROM derived_memory_legacy_clear_plan
       ) ids
       JOIN derived_memory_legacy_clear_audit d ON d.run_id=ids.dry_run_id
       WHERE d.mode='dry_run' AND d.finished_at < $1::timestamptz - ($2::bigint * interval '1 millisecond')`,
      [started, maxAge],
    );
    for (const expired of expiredPlans.rows)
      await purgePlan(runner, expired.dry_run_id);
    await runner.query('COMMIT');
    let runId: string = randomUUID();
    activeRunId = runId;
    await runner.query('BEGIN');
    const { sessions, counts, reconciliationComplete } =
      await classifySessions(runner);
    if (!dryRun && backupConfirmedAt) {
      const fresh = await runner.query<{ fresh: boolean }>(
        "SELECT $1::timestamptz <= clock_timestamp() AND $1::timestamptz >= clock_timestamp() - interval '24 hours' AS fresh",
        [backupConfirmedAt],
      );
      if (!fresh.rows[0]?.fresh) backupConfirmedAt = null;
    }
    if (!dryRun && !backupConfirmedAt) {
      await runner.query(
        `INSERT INTO derived_memory_legacy_clear_audit(run_id,mode,code_version,dry_run_id,counts,outcome,started_at,finished_at,reason_code)
         VALUES($1,'live',$2,$3,$4::jsonb,'aborted',$5,$5,'backup_not_confirmed')`,
        [runId, codeVersion, dryRunId, JSON.stringify(counts), started],
      );
      if (dryRunId) await purgePlan(runner, dryRunId);
      await runner.query('COMMIT');
      throw new Error(
        'Live clear requires a valid backup attestation from the last 24 hours',
      );
    }
    let resumeCounts: Record<string, number> | null = null;
    let removedSummaries = 0;
    let removedEntries = 0;
    let removedFacts = 0;
    let idempotentCompletion = false;
    if (!dryRun && !reconciliationComplete) {
      await runner.query(
        `INSERT INTO derived_memory_legacy_clear_audit(run_id,mode,code_version,dry_run_id,counts,outcome,started_at,finished_at,reason_code)
         VALUES($1,'live',$2,$3,$4::jsonb,'aborted',$5,$5,'global_reconciliation_incomplete')`,
        [runId, codeVersion, dryRunId, JSON.stringify(counts), started],
      );
      await runner.query(
        'UPDATE derived_memory_legacy_clear_audit SET backup_confirmed_at=$2 WHERE run_id=$1',
        [runId, backupConfirmedAt],
      );
      if (dryRunId) await purgePlan(runner, dryRunId);
      await runner.query('COMMIT');
      emit(options, 'legacy_clear_live_aborted', counts, 'aborted');
      throw new Error(
        'Live clear requires global reference reconciliation to be complete; refusing to report success while coverage is unverified',
      );
    }
    if (!dryRun) {
      const newestDryRunId = dryRunId;
      if (newestDryRunId) {
        const supersededLives = await runner.query<{ dry_run_id: string }>(
          "UPDATE derived_memory_legacy_clear_audit SET reason_code='superseded_by_new_dry_run',finished_at=clock_timestamp() WHERE mode='live' AND code_version=$1 AND outcome='failed' AND reason_code='process_died' AND dry_run_id IS DISTINCT FROM $2 AND started_at >= $3::timestamptz - ($4::bigint * interval '1 millisecond') RETURNING dry_run_id::text",
          [codeVersion, newestDryRunId, started, maxAge],
        );
        for (const superseded of supersededLives.rows)
          await purgePlan(runner, superseded.dry_run_id);
      }
      if (newestDryRunId) {
        const identityPlan = await planMatchesCurrent(
          runner,
          newestDryRunId,
          sessions,
        );
        activePlanRows = identityPlan.rows;
        if (!identityPlan.markerExists) {
          await runner.query(
            `INSERT INTO derived_memory_legacy_clear_audit(run_id,mode,code_version,dry_run_id,counts,outcome,started_at,finished_at,reason_code)
             VALUES($1,'live',$2,$3,$4::jsonb,'aborted',$5,$5,'plan_missing_run_dry_run_again')`,
            [
              runId,
              codeVersion,
              newestDryRunId,
              JSON.stringify(counts),
              started,
            ],
          );
          if (backupConfirmedAt)
            await runner.query(
              'UPDATE derived_memory_legacy_clear_audit SET backup_confirmed_at=$2 WHERE run_id=$1',
              [runId, backupConfirmedAt],
            );
          await purgePlan(runner, newestDryRunId);
          await runner.query('COMMIT');
          throw new Error(
            'plan_missing_run_dry_run_again: plan metadata is unavailable; run a fresh dry run before live execution',
          );
        }
        if (!identityPlan.matches) {
          await runner.query(
            `INSERT INTO derived_memory_legacy_clear_audit(run_id,mode,code_version,dry_run_id,counts,outcome,started_at,finished_at,reason_code)
             VALUES($1,'live',$2,$3,$4::jsonb,'aborted',$5,$5,'plan_digest_mismatch')`,
            [
              runId,
              codeVersion,
              newestDryRunId,
              JSON.stringify(counts),
              started,
            ],
          );
          if (backupConfirmedAt)
            await runner.query(
              'UPDATE derived_memory_legacy_clear_audit SET backup_confirmed_at=$2 WHERE run_id=$1',
              [runId, backupConfirmedAt],
            );
          await purgePlan(runner, newestDryRunId);
          await runner.query('COMMIT');
          emit(options, 'legacy_clear_live_aborted', counts, 'aborted');
          throw new PlanDigestMismatchError();
        }
      }
      const resumable = await runner.query<AuditRow>(
        `SELECT run_id,dry_run_id,counts,finished_at,outcome FROM derived_memory_legacy_clear_audit
         WHERE mode='live' AND code_version=$1 AND dry_run_id=$2
           AND (outcome='live_partial' OR (outcome='failed' AND reason_code='process_died'))
           AND started_at >= $3::timestamptz - ($4::bigint * interval '1 millisecond')
         ORDER BY started_at DESC LIMIT 1`,
        [codeVersion, newestDryRunId, started, maxAge],
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
          await purgePlan(runner, resume.dry_run_id);
          await runner.query('COMMIT');
          emit(options, 'legacy_clear_live_aborted', counts, 'aborted');
          throw new Error(
            'Resumed live candidate counts no longer equal the original dry-run plan; refusing to continue',
          );
        }
        runId = resume.run_id;
        activeRunId = runId;
        dryRunId = resume.dry_run_id;
        activeDryRunId = resume.dry_run_id;
        await runner.query(
          "UPDATE derived_memory_legacy_clear_audit SET outcome='running',finished_at=NULL,heartbeat_at=clock_timestamp() WHERE run_id=$1",
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
        activeDryRunId = dryRunId;
        activePlanRows = dryRunId ? await readPlanRows(runner, dryRunId) : [];
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
          if (dryRunId) await purgePlan(runner, dryRunId);
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
      if (dryRun) {
        await runner.query(
          'INSERT INTO derived_memory_legacy_clear_plan_runs(dry_run_id) VALUES($1)',
          [runId],
        );
        for (const session of sessions) {
          if (session.held || session.deferred) continue;
          const ids: CandidateIds = {
            sceneSummaryIds: session.plannedSummaryIds,
            registryEntryIds: session.plannedEntryIds,
            registryFactIds: session.plannedFactIds,
          };
          await runner.query(
            `INSERT INTO derived_memory_legacy_clear_plan
               (dry_run_id,session_id,digest,counts,scene_summary_ids,registry_entry_ids,registry_fact_ids)
             VALUES($1,$2,$3,$4::jsonb,$5::bigint[],$6::bigint[],$7::bigint[])`,
            [
              runId,
              session.session_id,
              planDigest(session.session_id, ids),
              JSON.stringify(candidateCounts(ids)),
              ids.sceneSummaryIds,
              ids.registryEntryIds,
              ids.registryFactIds,
            ],
          );
        }
      }
    }
    await runner.query('COMMIT');
    if (!dryRun) {
      heartbeatClient = await pool.connect();
      const heartbeatInterval = Math.min(
        30_000,
        positiveInt(
          options.heartbeatIntervalMsForTests ?? 30_000,
          'heartbeat interval',
        ),
      );
      heartbeatTimer = setInterval(() => {
        if (heartbeatState.pending) return;
        heartbeatState.pending = heartbeatClient!
          .query(
            "UPDATE derived_memory_legacy_clear_audit SET heartbeat_at=clock_timestamp() WHERE run_id=$1 AND outcome='running'",
            [runId],
          )
          .then(
            () => undefined,
            () => undefined,
          )
          .finally(() => {
            heartbeatState.pending = null;
          });
      }, heartbeatInterval);
      heartbeatTimer.unref();
    }
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
      const completedSessionIds = new Set<string>();
      const newlyHeldSessionIds = new Set<string>();
      removedSummaries = resumeCounts?.sceneSummariesRemoved ?? 0;
      removedEntries = resumeCounts?.registryEntriesRemoved ?? 0;
      removedFacts = resumeCounts?.registryFactsRemoved ?? 0;
      const persistBatchProgress = async (
        sessionId?: string,
        markDone = false,
      ) => {
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
          'UPDATE derived_memory_legacy_clear_audit SET counts=$2::jsonb,heartbeat_at=clock_timestamp() WHERE run_id=$1',
          [runId, JSON.stringify(progressCounts)],
        );
        if (markDone && dryRunId && sessionId) {
          await runner.query(
            "UPDATE derived_memory_legacy_clear_plan SET state='done' WHERE dry_run_id=$1 AND session_id=$2",
            [dryRunId, sessionId],
          );
          completedSessionIds.add(sessionId);
        }
        await runner.query('COMMIT');
      };
      let sessionIndex = 0;
      for (const session of sessions) {
        const sessionPlan = activePlanRows.find(
          (row) => row.session_id === session.session_id,
        );
        if (session.held || session.deferred || sessionPlan?.state === 'done')
          continue;
        if (!sessionPlan) throw new PlanDigestMismatchError();
        await options.beforeSessionLockForTests?.(
          session.session_id,
          sessionIndex++,
        );
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
            const currentIds = await candidateIdsForSession(
              runner,
              session.session_id,
            );
            if (
              planDigest(session.session_id, currentIds) !== sessionPlan.digest
            )
              throw new PlanDigestMismatchError();
            await persistBatchProgress(session.session_id, true);
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
            newlyHeldSessionIds.add(session.session_id);
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
          const currentIds = await candidateIdsForSession(
            runner,
            session.session_id,
          );
          if (planDigest(session.session_id, currentIds) !== sessionPlan.digest)
            throw new PlanDigestMismatchError();
          const before = candidateCounts(currentIds);
          const plannedIds: CandidateIds = {
            sceneSummaryIds: sessionPlan.sceneSummaryIds,
            registryEntryIds: sessionPlan.registryEntryIds,
            registryFactIds: sessionPlan.registryFactIds,
          };
          if (
            before.sceneSummaries !== sessionPlan.counts.sceneSummaries ||
            before.registryEntries !== sessionPlan.counts.registryEntries ||
            before.registryFacts !== sessionPlan.counts.registryFacts
          )
            throw new PlanDigestMismatchError();
          await options.afterSessionIdentityCheckForTests?.(
            runner,
            session.session_id,
          );
          await runner.query(
            'UPDATE registry_facts SET supersedes_id=NULL,superseded_by=NULL WHERE id=ANY($1::bigint[]) AND entry_id=ANY($2::bigint[])',
            [plannedIds.registryFactIds, plannedIds.registryEntryIds],
          );
          await runner.query(
            'UPDATE registry_entries SET superseded_by=NULL WHERE id=ANY($1::bigint[]) AND session_id=$2',
            [plannedIds.registryEntryIds, session.session_id],
          );
          const deletedFacts = await runner.query(
            'DELETE FROM registry_facts WHERE id=ANY($1::bigint[]) AND entry_id=ANY($2::bigint[]) RETURNING id',
            [plannedIds.registryFactIds, plannedIds.registryEntryIds],
          );
          if (deletedFacts.rowCount !== plannedIds.registryFactIds.length)
            throw new PlanDigestMismatchError();
          const deletedEntries = await runner.query(
            `DELETE FROM registry_entries e
              WHERE e.id=ANY($1::bigint[]) AND e.session_id=$2
                AND NOT EXISTS (SELECT 1 FROM derived_memory_character_refs r WHERE r.row_kind='registry_entry' AND r.row_id=e.id)
                AND e.supersedes_id IS NULL AND e.superseded_by IS NULL
                AND NOT EXISTS (SELECT 1 FROM registry_facts f WHERE f.entry_id=e.id)
              RETURNING e.id`,
            [plannedIds.registryEntryIds, session.session_id],
          );
          if (deletedEntries.rowCount !== plannedIds.registryEntryIds.length)
            throw new PlanDigestMismatchError();
          const deletedSummaries = await runner.query(
            `DELETE FROM scene_summaries s
              WHERE s.id=ANY($1::bigint[]) AND s.session_id=$2 AND NOT EXISTS (
                SELECT 1 FROM derived_memory_character_refs r
                 WHERE r.session_id=s.session_id AND r.row_kind='scene_summary' AND r.row_id=s.id
              ) RETURNING s.id`,
            [plannedIds.sceneSummaryIds, session.session_id],
          );
          if (deletedSummaries.rowCount !== plannedIds.sceneSummaryIds.length)
            throw new PlanDigestMismatchError();
          removedSummaries += before.sceneSummaries;
          removedEntries += before.registryEntries;
          removedFacts += before.registryFacts;
          await persistBatchProgress(session.session_id, true);
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
      const partial = sessions.some(
        (session) =>
          !session.held &&
          !session.deferred &&
          activePlanRows.find((row) => row.session_id === session.session_id)
            ?.state !== 'done' &&
          !completedSessionIds.has(session.session_id) &&
          !newlyHeldSessionIds.has(session.session_id),
      );
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
      await saveAudit(runner, runId, auditCounts, outcome);
      if (outcome === 'live_succeeded' && dryRunId)
        await purgePlan(runner, dryRunId);
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
    await saveAudit(runner, runId, counts, outcome);
    const supersededPlans = await runner.query<{ dry_run_id: string }>(
      `SELECT DISTINCT ids.dry_run_id::text
       FROM (
         SELECT dry_run_id FROM derived_memory_legacy_clear_plan_runs
         UNION
         SELECT dry_run_id FROM derived_memory_legacy_clear_plan
       ) ids
       JOIN derived_memory_legacy_clear_audit d ON d.run_id=ids.dry_run_id
       WHERE d.mode='dry_run' AND d.code_version=$1 AND d.outcome='dry_run_succeeded'
         AND ids.dry_run_id<>$2`,
      [codeVersion, runId],
    );
    for (const oldPlan of supersededPlans.rows) {
      await runner.query(
        `UPDATE derived_memory_legacy_clear_audit
         SET outcome='failed',reason_code='superseded_by_new_dry_run',finished_at=clock_timestamp()
         WHERE mode='live' AND dry_run_id=$1 AND outcome IN ('live_partial','failed')
           AND (outcome='live_partial' OR reason_code='process_died')`,
        [oldPlan.dry_run_id],
      );
      await purgePlan(runner, oldPlan.dry_run_id);
    }
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
        await runner.query('BEGIN');
        const failed = await runner.query(
          "UPDATE derived_memory_legacy_clear_audit SET outcome='failed',reason_code=CASE WHEN $2 THEN 'plan_digest_mismatch' ELSE NULL END,finished_at=clock_timestamp() WHERE run_id=$1 AND outcome IN ('running','live_partial') RETURNING run_id",
          [activeRunId, error instanceof PlanDigestMismatchError],
        );
        if (!dryRun && activeDryRunId && failed.rowCount)
          await purgePlan(runner, activeDryRunId);
        await runner.query('COMMIT');
      } catch {
        try {
          await runner.query('ROLLBACK');
        } catch {
          /* no transaction */
        }
        /* audit table may not exist, or preflight may not have inserted a run */
      }
    }
    throw error;
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (heartbeatState.pending) await heartbeatState.pending;
    heartbeatClient?.release();
    if (lockHeld)
      await runner.query('SELECT pg_advisory_unlock($1)', [
        LEGACY_CLEAR_LOCK_KEY,
      ]);
    runner.release();
  }
}
