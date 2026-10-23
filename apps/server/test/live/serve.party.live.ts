import { allowInputGate } from '../support/allowInputGate.js';
// Not a test: Playwright's webServer runs this file through vitest to host the real party
// server (real Room, Postgres, scripted DM, no network) for the party browser e2e.
// It seeds one host and three other adult accounts, seats the first two through the real
// invite-join route, opens the table's first round, writes {tokens, table, invite...} to
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
import { isLocalDatabaseUrl } from './localDatabaseUrl.js';

it('serves a party table (host, two seated guests, one outsider) for browser e2e', async () => {
  const url = process.env.DATABASE_URL;
  const stateFile = process.env.LIVE_STATE_FILE;
  const port = Number(process.env.LIVE_PORT ?? 8799);
  if (!url || !stateFile)
    throw new Error('DATABASE_URL and LIVE_STATE_FILE required');
  if (!isLocalDatabaseUrl(url))
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
    'live-party-e2e',
    600_000,
    60_000,
    runner,
  );
  const connections = new ConnectionRegistry(db);
  // The chat moderation judge is an LLM call; this harness allows chat so the spec can test the
  // party chat path itself (ws.ts treats a missing checkChat as judge_error).
  const partyInputGate = {
    ...allowInputGate,
    checkChat: async () => ({
      decision: 'allow' as const,
      attributable: false,
    }),
  };
  const app = createApp(db, { inputGate: partyInputGate, rooms, connections });
  installGateway(app, db, rooms, connections, 300);

  const seedAccount = async (displayName: string) => {
    const id = randomUUID();
    await db.query(
      `INSERT INTO accounts(id,email,password_hash,display_name,status,is_adult,age_checked_at,terms_version,terms_accepted_at) VALUES($1,$2,'hash',$3,'active',true,now(),'v1',now())`,
      [id, `${id}@example.test`, displayName],
    );
    return { id, token: await createSession(db, id, 'live-party-e2e') };
  };
  const cookie = (token: string) => ({ cookie: `sid=${token}` });

  const host = await seedAccount('Round Host');
  const guest = await seedAccount('Round Guest');
  const scout = await seedAccount('Round Scout');
  const outsider = await seedAccount('Latecomer');

  // The host creates the party table the way the Lobby does, then mints its invite.
  const created = await app.inject({
    method: 'POST',
    url: '/api/rooms',
    headers: { ...cookie(host.token), 'content-type': 'application/json' },
    payload: { name: 'Party table' },
  });
  if (created.statusCode !== 201)
    throw new Error(
      `table create failed: ${created.statusCode} ${created.body}`,
    );
  const table = (created.json() as { room: { id: string } }).room.id;
  const invited = await app.inject({
    method: 'POST',
    url: `/api/rooms/${table}/invite`,
    headers: cookie(host.token),
  });
  if (invited.statusCode !== 200)
    throw new Error(`invite failed: ${invited.statusCode} ${invited.body}`);
  const invite = (invited.json() as { room: { code: string } }).room.code;

  // Guests seat through the real invite-join route (no game state yet, so this seats them).
  for (const seated of [guest, scout]) {
    const joined = await app.inject({
      method: 'POST',
      url: `/api/invites/${invite}/join`,
      headers: { ...cookie(seated.token), 'content-type': 'application/json' },
      payload: {},
    });
    if (joined.statusCode !== 200)
      throw new Error(`join failed: ${joined.statusCode} ${joined.body}`);
  }

  // Each seated account plays its own character, keyed by account, as the production path does.
  const characters = Object.fromEntries(
    [host, guest, scout].map((account) => [
      account.id,
      { ...hero, id: randomUUID() },
    ]),
  );
  const room = await rooms.get(table);
  await room.persistGameState({
    ...preCombatGame(hero),
    characters,
  });

  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(
    stateFile,
    JSON.stringify({
      table,
      invite,
      host: { accountId: host.id, token: host.token },
      guest: { accountId: guest.id, token: guest.token },
      scout: { accountId: scout.id, token: scout.token },
      outsider: { accountId: outsider.id, token: outsider.token },
    }),
  );
  // Listen last: Playwright treats the first HTTP answer as "ready", and the state file exists by now.
  await app.listen({ host: '127.0.0.1', port });
  await new Promise<void>(() => {});
}, 0);
