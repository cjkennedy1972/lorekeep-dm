import { allowInputGate } from '../support/allowInputGate.js';
// Not a test: Playwright's webServer runs this file through vitest to host the real party
// server (real Room, Postgres, scripted DM, no network) for the party browser e2e.
// It seeds two tables. The round table has one host and two seated guests, plus an outsider.
// The combat table has three seated members whose sheets are bound to their seats and whose
// encounter was started with the real start_combat executor. Both tables get a quick-built
// sheet per seat, saved to the account and bound through Room.bindSeatCharacter, as production
// does. The state file records the tables, invites, tokens, and each combat member's entity id.
// The server then listens on LIVE_PORT and runs until it is killed.
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Pool } from 'pg';
import { it } from 'vitest';
import { quickBuild } from '@game/rules-engine';
import { loadCatalog } from '@game/rules-engine/catalog-node';
import type { CharacterInput } from '@game/rules-engine';
import { createApp } from '../../src/app.js';
import { createSession } from '../../src/accounts/sessions.js';
import { installGateway } from '../../src/gateway/ws.js';
import { ConnectionRegistry } from '../../src/gateway/connections.js';
import { Persistence } from '../../src/persistence/index.js';
import { SeatCharacterRepository } from '../../src/persistence/seatCharacters.js';
import type { Room } from '../../src/room/Room.js';
import { RoomRegistry } from '../../src/room/registry.js';
import { SessionLease } from '../../src/room/lease.js';
import { seatEntityId } from '../../src/room/seatEntity.js';
import { ProductionSoloTurnRunner } from '../../src/room/productionTurnRunner.js';
import { hero, partyCombat, preCombatGame } from '../room/combatFixtures.js';
import { scriptedDm } from '../room/scriptedDm.js';
import { isLocalDatabaseUrl } from './localDatabaseUrl.js';

it('serves party tables (a round table and a combat table, both bound to seats) for browser e2e', async () => {
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
  // The invite-join throttle (10 hits per IP and invite per 60 s) is shared by every spec in this
  // serial suite. Raise it for the harness only so no spec has to wait out the window.
  const app = createApp(db, {
    inputGate: partyInputGate,
    rooms,
    connections,
    joinRateLimit: 1000,
  });
  // Specs use repeated reconnects with the same fixture seats. Keep the production
  // limiter behavior covered by gateway.test.ts, and isolate each browser scenario.
  app.post('/api/test/reset-auth-attempts', async () => {
    connections.resetAuthAttemptHistory();
    return { ok: true };
  });
  installGateway(app, db, rooms, connections, 300);

  const catalog = loadCatalog();
  const seats = new SeatCharacterRepository(db);
  let sheetSeed = 0x40;

  const seedAccount = async (displayName: string) => {
    const id = randomUUID();
    await db.query(
      `INSERT INTO accounts(id,email,password_hash,display_name,status,is_adult,age_checked_at,terms_version,terms_accepted_at) VALUES($1,$2,'hash',$3,'active',true,now(),'v1',now())`,
      [id, `${id}@example.test`, displayName],
    );
    return { id, token: await createSession(db, id, 'live-party-e2e') };
  };
  const cookie = (token: string) => ({ cookie: `sid=${token}` });
  type Seated = { id: string; token: string };

  // The owner creates the table the way the Lobby does, mints its invite, and the joiners seat
  // through the real invite-join route.
  const openTable = async (name: string, owner: Seated, joiners: Seated[]) => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/rooms',
      headers: { ...cookie(owner.token), 'content-type': 'application/json' },
      payload: { name },
    });
    if (created.statusCode !== 201)
      throw new Error(
        `table create failed: ${created.statusCode} ${created.body}`,
      );
    const table = (created.json() as { room: { id: string } }).room.id;
    const invited = await app.inject({
      method: 'POST',
      url: `/api/rooms/${table}/invite`,
      headers: cookie(owner.token),
    });
    if (invited.statusCode !== 200)
      throw new Error(`invite failed: ${invited.statusCode} ${invited.body}`);
    const invite = (invited.json() as { room: { code: string } }).room.code;
    for (const seated of joiners) {
      const joined = await app.inject({
        method: 'POST',
        url: `/api/invites/${invite}/join`,
        headers: {
          ...cookie(seated.token),
          'content-type': 'application/json',
        },
        payload: {},
      });
      if (joined.statusCode !== 200)
        throw new Error(`join failed: ${joined.statusCode} ${joined.body}`);
    }
    return { table, invite };
  };

  // A quick-built sheet saved to the account, then bound to its seat through the live room, so the
  // room's in-memory bindings are current (the production bind path).
  const bindSheet = async (room: Room, account: Seated) => {
    const character = {
      ...quickBuild(catalog, undefined, sheetSeed++, 1).character,
      id: randomUUID(),
    } as CharacterInput;
    const revision = await seats.saveOwnedCharacter(account.id, character);
    await room.bindSeatCharacter(
      account.id,
      character.id,
      revision,
      async () => true,
      randomUUID(),
    );
    return character;
  };
  const seatIdOf = (room: Room, accountId: string) => {
    const seat = room.state.seats.find((item) => item.accountId === accountId);
    if (!seat) throw new Error(`no seat for ${accountId}`);
    return seat.seatId;
  };

  const host = await seedAccount('Round Host');
  const guest = await seedAccount('Round Guest');
  const scout = await seedAccount('Round Scout');
  const outsider = await seedAccount('Latecomer');
  // A late joiner picks an owned sheet in the request, so the outsider owns one (unbound, as it is not seated).
  await seats.saveOwnedCharacter(outsider.id, {
    ...quickBuild(catalog, undefined, sheetSeed++, 1).character,
    id: randomUUID(),
  } as CharacterInput);

  const round = await openTable('Party table', host, [guest, scout]);
  const roundRoom = await rooms.get(round.table);
  const roundCharacters: Record<string, CharacterInput> = {};
  for (const member of [host, guest, scout])
    roundCharacters[member.id] = await bindSheet(roundRoom, member);
  await roundRoom.persistGameState({
    ...preCombatGame(hero),
    characters: roundCharacters,
  });

  // The combat table is separate, so round specs never see an encounter in progress.
  const combatHost = await seedAccount('Combat Host');
  const combatGuest = await seedAccount('Combat Guest');
  const combatScout = await seedAccount('Combat Scout');
  const combat = await openTable('Party combat table', combatHost, [
    combatGuest,
    combatScout,
  ]);
  const combatRoom = await rooms.get(combat.table);
  const combatMembers = [combatHost, combatGuest, combatScout];
  const combatCharacters: Record<string, CharacterInput> = {};
  for (const member of combatMembers)
    combatCharacters[member.id] = await bindSheet(combatRoom, member);
  // Fixture placement only: the start_combat encounter puts goblins far from the party, so the spec needs one in reach.
  const placeToken = (
    combatState: { entities: { id: string; pos: { x: number; y: number } }[] },
    id: string,
    pos: { x: number; y: number },
  ) => {
    const token = combatState.entities.find((item) => item.id === id);
    if (!token) throw new Error(`no token ${id} to place`);
    token.pos = pos;
  };
  // Party sheets are keyed by account; reconcile rekeys them to ent_seat_<seatId> through the bindings.
  const combatGame = partyCombat(
    7,
    combatCharacters,
    combatRoom.seatCharacters,
  );
  // The keyboard spec attacks from (10,2), the first seat's start, against the goblin placed at (11,2).
  placeToken(combatGame.combatRoom, 'ent_goblin-minion_1', { x: 11, y: 2 });
  await combatRoom.persistGameState(combatGame);
  const combatEntity = (member: Seated) =>
    seatEntityId(seatIdOf(combatRoom, member.id));

  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(
    stateFile,
    JSON.stringify({
      table: round.table,
      invite: round.invite,
      host: { accountId: host.id, token: host.token },
      guest: { accountId: guest.id, token: guest.token },
      scout: { accountId: scout.id, token: scout.token },
      outsider: { accountId: outsider.id, token: outsider.token },
      combat: {
        table: combat.table,
        invite: combat.invite,
        host: {
          accountId: combatHost.id,
          token: combatHost.token,
          entityId: combatEntity(combatHost),
        },
        guest: {
          accountId: combatGuest.id,
          token: combatGuest.token,
          entityId: combatEntity(combatGuest),
        },
        scout: {
          accountId: combatScout.id,
          token: combatScout.token,
          entityId: combatEntity(combatScout),
        },
      },
    }),
    // Holds bearer tokens: owner-only.
    { mode: 0o600 },
  );
  // Listen last: Playwright treats the first HTTP answer as "ready", and the state file exists by now.
  await app.listen({ host: '127.0.0.1', port });
  await new Promise<void>(() => {});
}, 0);
