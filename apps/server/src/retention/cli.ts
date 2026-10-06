import { Pool } from 'pg';
import { loadConfig } from '../config.js';
import { LocalObjectStore } from '../storage/objectStore.js';
import { runSweep } from './sweeper.js';

const db = new Pool({ connectionString: loadConfig().DATABASE_URL });
try {
  const result = await runSweep(db, { store: new LocalObjectStore() });
  console.log(
    JSON.stringify({
      component: 'retention',
      summary: result ?? 'skipped_locked',
    }),
  );
  if (result && result.accounts.failed > 0) process.exitCode = 1;
} finally {
  await db.end();
}
