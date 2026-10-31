import { Pool } from 'pg';
import { loadConfig } from '../config.js';
import { runLegacyDerivedMemoryClear } from './jobs/legacyDerivedMemoryClear.js';

const enabled = process.env.DERIVED_MEMORY_LEGACY_CLEAR_ENABLED === 'true';
const dryRun = process.env.DERIVED_MEMORY_LEGACY_CLEAR_DRY_RUN !== 'false';
if (!enabled)
  throw new Error(
    'Set DERIVED_MEMORY_LEGACY_CLEAR_ENABLED=true to invoke this separate job',
  );
if (!dryRun && process.env.DERIVED_MEMORY_LEGACY_CLEAR_DRY_RUN !== 'false')
  throw new Error(
    'Live mode requires DERIVED_MEMORY_LEGACY_CLEAR_DRY_RUN=false',
  );
const codeVersion = process.env.DERIVED_MEMORY_LEGACY_CLEAR_CODE_VERSION;
if (!codeVersion)
  throw new Error(
    'Set DERIVED_MEMORY_LEGACY_CLEAR_CODE_VERSION to the exact deployed code version',
  );

const db = new Pool({ connectionString: loadConfig().DATABASE_URL });
try {
  const result = await runLegacyDerivedMemoryClear(db, {
    enabled,
    dryRun,
    codeVersion,
  });
  console.log(
    JSON.stringify({
      component: 'derived-memory-legacy-clear',
      event: 'legacy_clear_run_finished',
      mode: dryRun ? 'dry_run' : 'live',
      counts: result.counts,
      outcome: result.outcome,
    }),
  );
  if (result.outcome === 'live_partial') process.exitCode = 2;
} finally {
  await db.end();
}
