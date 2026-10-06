import { Pool } from 'pg';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { setupTelemetry } from './telemetry.js';
import { Persistence } from './persistence/index.js';
import { SessionLease } from './room/lease.js';
import { RoomRegistry } from './room/registry.js';
import { installGracefulDrain } from './room/drain.js';
import { installGateway } from './gateway/ws.js';
const config = loadConfig();
const telemetry = setupTelemetry(config);
const db = new Pool({ connectionString: config.DATABASE_URL });
export const rooms = new RoomRegistry(
  new Persistence(db),
  new SessionLease(db),
  crypto.randomUUID(),
);
const app = createApp(db, { rooms });
installGateway(app, db, rooms);
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await rooms.drain();
  await app.close();
  await db.end();
  await telemetry?.shutdown();
}
process.once('SIGINT', () => {
  void shutdown();
});
installGracefulDrain(rooms, async () => {
  await app.close();
  await db.end();
  await telemetry?.shutdown();
});
try {
  await app.listen({ host: config.HOST, port: config.PORT });
} catch (error) {
  app.log.error(error, 'server startup failed');
  await shutdown();
  process.exitCode = 1;
}
