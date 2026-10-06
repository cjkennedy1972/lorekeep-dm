import { Pool } from 'pg';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { setupTelemetry } from './telemetry.js';
const config = loadConfig();
const telemetry = setupTelemetry(config);
const db = new Pool({ connectionString: config.DATABASE_URL });
const app = createApp(db);
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await app.close();
  await db.end();
  await telemetry?.shutdown();
}
process.once('SIGINT', () => {
  void shutdown();
});
process.once('SIGTERM', () => {
  void shutdown();
});
try {
  await app.listen({ host: config.HOST, port: config.PORT });
} catch (error) {
  app.log.error(error, 'server startup failed');
  await shutdown();
  process.exitCode = 1;
}
