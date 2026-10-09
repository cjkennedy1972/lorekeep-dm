// Not a test: Playwright's webServer runs this file through vitest to host the real
// server (real Room, Postgres, recorded/scripted DM, no network) for the browser e2e.
// It seeds one adult account and a pre-combat table, writes {token, table} to
// LIVE_STATE_FILE, then listens on LIVE_PORT and runs until it is killed.
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Pool } from 'pg';
import { it } from 'vitest';
import { createApp } from '../../src/app.js';
import { createSession } from '../../src/accounts/sessions.js';
import { installGateway } from '../../src/gateway/ws.js';
import { ConnectionRegistry } from '../../src/gateway/connections.js';
import { Persistence } from '../../src/persistence/index.js';
import { RoomRegistry } from '../../src/room/registry.js';
import { SessionLease } from '../../src/room/lease.js';
import { ProductionSoloTurnRunner } from '../../src/room/productionTurnRunner.js';
import { hero, preCombatGame } from '../room/combatFixtures.js';
import { scriptedDm } from '../room/scriptedDm.js';

it('serves the recorded combat stack for browser e2e', async () => {
  const url = process.env.DATABASE_URL;
  const stateFile = process.env.LIVE_STATE_FILE;
  const port = Number(process.env.LIVE_PORT ?? 8799);
  if (!url || !stateFile)
    throw new Error('DATABASE_URL and LIVE_STATE_FILE required');
  process.env.NODE_ENV = 'test';
  process.env.LLM_FIXTURE_MODE = 'strict';
  const db = new Pool({ connectionString: url });
  const runner = new ProductionSoloTurnRunner(
    db,
    undefined,
    'strict',
    'unused.ndjson',
    scriptedDm(),
  );
  const rooms = new RoomRegistry(
    new Persistence(db),
    new SessionLease(db),
    'live-e2e',
    600_000,
    60_000,
    runner,
  );
  const connections = new ConnectionRegistry(db);
  const app = createApp(db, { rooms, connections });
  installGateway(app, db, rooms, connections, 300);

  const accountId = randomUUID();
  await db.query(
    `INSERT INTO accounts(id,email,password_hash,display_name,status,is_adult,age_checked_at,terms_version,terms_accepted_at) VALUES($1,$2,'hash','Aria','active',true,now(),'v1',now())`,
    [accountId, `${accountId}@example.test`],
  );
  const token = await createSession(db, accountId, 'live-e2e');
  const table = randomUUID();
  await db.query(
    'INSERT INTO sessions(id,owner_account_id,name) VALUES($1,$2,$3)',
    [table, accountId, 'Crypt'],
  );
  // Production party entities use the character's uuid as their id.
  const party = { ...hero, id: randomUUID() };
  const room = await rooms.get(table);
  await room.seat(accountId, 'Aria');
  await room.persistGameState({
    ...preCombatGame(party),
    characters: { [accountId]: party },
  });
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(
    stateFile,
    JSON.stringify({ token, table, accountId, heroId: party.id }),
  );
  // Listen last: Playwright treats the first HTTP answer as "ready", and the state file exists by now.
  await app.listen({ host: '127.0.0.1', port });
  await new Promise<void>(() => {});
}, 0);
