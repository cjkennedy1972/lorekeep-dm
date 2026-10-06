import { Pool } from 'pg';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { setupTelemetry } from './telemetry.js';
import { Persistence } from './persistence/index.js';
import { SessionLease } from './room/lease.js';
import { RoomRegistry } from './room/registry.js';
import { installGracefulDrain } from './room/drain.js';
import { installGateway } from './gateway/ws.js';
import { startSweepScheduler } from './retention/sweeper.js';
import { LocalObjectStore } from './storage/objectStore.js';
import { ConnectionRegistry } from './gateway/connections.js';
const config = loadConfig();
const telemetry = setupTelemetry(config);
const db = new Pool({ connectionString: config.DATABASE_URL });
export const rooms = new RoomRegistry(
  new Persistence(db),
  new SessionLease(db),
  crypto.randomUUID(),
);
const connections = new ConnectionRegistry(db);
const app = createApp(db, { rooms, connections });
const closeGateway = installGateway(app, db, rooms, connections);
// Disabled in tests or with SWEEP_INTERVAL_MS=0.
const stopSweeper =
  config.NODE_ENV === 'test' || config.SWEEP_INTERVAL_MS === 0
    ? () => undefined
    : startSweepScheduler(db, new LocalObjectStore(), config.SWEEP_INTERVAL_MS);
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  stopSweeper();
  await closeGateway();
  await rooms.drain();
  await app.close();
  await db.end();
  await telemetry?.shutdown();
}
installGracefulDrain(shutdown, process.exit, (error) =>
  app.log.error(error, 'server shutdown failed'),
);
process.once('SIGINT', () => {
  void shutdown().catch((error) => {
    app.log.error(error, 'server shutdown failed');
    process.exitCode = 1;
  });
});
try {
  await app.listen({ host: config.HOST, port: config.PORT });
} catch (error) {
  app.log.error(error, 'server startup failed');
  await shutdown();
  process.exitCode = 1;
}
