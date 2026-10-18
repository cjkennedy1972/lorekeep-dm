import { allowInputGate } from '../support/allowInputGate.js';
// Not a test: Playwright's webServer runs this file through vitest to host the real
// server (real Room, Postgres, recorded/scripted DM, no network) for the browser e2e.
// It seeds one adult account and a pre-combat table, writes {token, table, ...} to
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
  if (!/@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url))
    throw new Error('refusing to seed a non-local DATABASE_URL');
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
  const app = createApp(db, { inputGate: allowInputGate, rooms, connections });
  installGateway(app, db, rooms, connections, 300);

  // The web client joins the account's most recently active table, so each spec needs its own account.
  const seedAccount = async (displayName: string) => {
    const id = randomUUID();
    await db.query(
      `INSERT INTO accounts(id,email,password_hash,display_name,status,is_adult,age_checked_at,terms_version,terms_accepted_at) VALUES($1,$2,'hash',$3,'active',true,now(),'v1',now())`,
      [id, `${id}@example.test`, displayName],
    );
    return { id, token: await createSession(db, id, 'live-e2e') };
  };
  // Create the table the way a real client does (solo mode, pinned catalog, adventure seed)...
  const seedTable = async (token: string, name: string) => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/tables',
      headers: { cookie: `sid=${token}`, 'content-type': 'application/json' },
      payload: {
        name,
        adventureId: 'adventure:01-hollow-under-marrowfell',
        difficulty: 'moderate',
        startingLevel: 1,
      },
    });
    if (created.statusCode !== 201)
      throw new Error(
        `table create failed: ${created.statusCode} ${created.body}`,
      );
    return (created.json() as { game: { id: string } }).game.id;
  };
  const { id: accountId, token } = await seedAccount('Aria');
  const table = await seedTable(token, 'Crypt');
  const { token: reportToken } = await seedAccount('Reporter');
  const reportTable = await seedTable(reportToken, 'Report probe');
  // Production party entities use the character's uuid as their id.
  const party = { ...hero, id: randomUUID() };
  // ...then replace its game state with the pre-combat fixture.
  const room = await rooms.get(table);
  await room.persistGameState({
    ...preCombatGame(party),
    characters: { [accountId]: party },
  });
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(
    stateFile,
    JSON.stringify({
      token,
      table,
      accountId,
      heroId: party.id,
      reportToken,
      reportTable,
    }),
  );
  // Listen last: Playwright treats the first HTTP answer as "ready", and the state file exists by now.
  await app.listen({ host: '127.0.0.1', port });
  await new Promise<void>(() => {});
}, 0);
