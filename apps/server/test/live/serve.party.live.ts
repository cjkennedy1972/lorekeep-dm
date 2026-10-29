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
import { moveAlong, quickBuild } from '@game/rules-engine';
import { loadCatalog } from '@game/rules-engine/catalog-node';
import type { CharacterInput } from '@game/rules-engine';
import { createApp } from '../../src/app.js';
import { createSession } from '../../src/accounts/sessions.js';
import { hashToken } from '../../src/accounts/signup.js';
import { installGateway } from '../../src/gateway/ws.js';
import { ConnectionRegistry } from '../../src/gateway/connections.js';
import { Persistence } from '../../src/persistence/index.js';
import { SeatCharacterRepository } from '../../src/persistence/seatCharacters.js';
import type { Room } from '../../src/room/Room.js';
import { RoomRegistry } from '../../src/room/registry.js';
import { SessionLease } from '../../src/room/lease.js';
import { applyMovement, movementState } from '../../src/room/combatEngine.js';
import type { RoomCombatState } from '../../src/room/combatTypes.js';
import { seatEntityId } from '../../src/room/seatEntity.js';
import { ProductionSoloTurnRunner } from '../../src/room/productionTurnRunner.js';
import { hero, partyCombat, preCombatGame } from '../room/combatFixtures.js';
import { scriptedDm } from '../room/scriptedDm.js';
import { isLocalDatabaseUrl } from './localDatabaseUrl.js';

type PartyGame = ReturnType<typeof partyCombat>;
type Pt = { x: number; y: number };
const cheb = (a: Pt, b: Pt) =>
  Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
const ringAround = (p: Pt): Pt[] =>
  [-1, 0, 1]
    .flatMap((dy) => [-1, 0, 1].map((dx) => ({ x: p.x + dx, y: p.y + dy })))
    .filter((q) => (q.x !== p.x || q.y !== p.y) && q.x >= 0 && q.y >= 0);
const occupied = (state: RoomCombatState, p: Pt) =>
  state.entities.some((e) => e.pos.x === p.x && e.pos.y === p.y);
const requireEntity = (state: RoomCombatState, id: string) => {
  const entity = state.entities.find((item) => item.id === id);
  if (!entity) throw new Error(`no token ${id}`);
  return entity;
};
// Fixture placement only: moves one token to the first free cell beside another.
const placeAdjacent = (
  state: RoomCombatState,
  id: string,
  anchorId: string,
) => {
  const token = requireEntity(state, id);
  const spot = ringAround(requireEntity(state, anchorId).pos).find(
    (p) => !occupied(state, p),
  );
  if (!spot) throw new Error(`no free cell beside ${anchorId}`);
  token.pos = spot;
};

// Fixture placement only: puts one token two cells east or west of another on a free in-map cell, so a
// Burning Hands cone aimed along the anchor's row catches it.
const placeTwoCellsAway = (
  state: RoomCombatState,
  id: string,
  anchorId: string,
) => {
  const token = requireEntity(state, id);
  const anchor = requireEntity(state, anchorId).pos;
  const spot = [2, -2]
    .map((dx) => ({ x: anchor.x + dx, y: anchor.y }))
    .find(
      (p) =>
        p.x >= 0 &&
        p.y >= 0 &&
        p.x < state.map.w &&
        p.y < state.map.h &&
        !occupied(state, p),
    );
  if (!spot) throw new Error(`no free cell two cells from ${anchorId}`);
  token.pos = spot;
};

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
  // Test-only: mints a fresh one-time seat resume token for a seated account. Room hands the
  // first tokenless socket a pending token that expires 30 s after SeatJoined; the fixture seats
  // every table at boot, so a spec opening later must mint its own. Mirrors the SeatJoined path.
  app.post('/api/test/mint-seat-resume', async (request, reply) => {
    const { table, accountId, token } = request.body as {
      table: string;
      accountId: string;
      token: string;
    };
    const room = await rooms.get(table);
    if (!room.state.seats.some((seat) => seat.accountId === accountId))
      return reply.code(404).send({ error: 'account is not seated' });
    const resumeToken = await new Persistence(db).createSeatResumeToken(
      table,
      seatIdOf(room, accountId),
    );
    (
      room as unknown as {
        setPendingSeatResumeToken(
          accountId: string,
          token: string,
          authTokenHash: string,
        ): void;
      }
    ).setPendingSeatResumeToken(accountId, resumeToken, hashToken(token));
    return { ok: true };
  });
  installGateway(app, db, rooms, connections, 300);

  // Test-only: the goblin's real engine move out of the reactor's reach, staged after every seat has
  // joined (Room.join would decline a window whose reactor is not connected yet). It runs the same
  // moveAlong, applyMovement and scheduleReaction calls a monster turn makes, so no product code is bypassed.
  // Registered before any inject: Fastify locks its routes once the app boots. The reaction table is
  // filled in below, so the handler reads it at request time.
  const reactionFixture: { room?: Room; base?: string } = {};
  // The combat table's pristine board. Specs that change it (moves, attacks, turns) restore it through
  // /api/test/reset-combat, so each spec starts from the same board whatever ran before it in this boot.
  const combatFixture: { room?: Room; base?: string } = {};
  app.post('/api/test/reset-combat', async (_request, reply) => {
    const room = combatFixture.room;
    const base = combatFixture.base;
    if (!room || !base)
      return reply.code(503).send({ error: 'combat table not seeded' });
    await room.persistGameState(JSON.parse(base));
    return { ok: true };
  });
  // The area table's pristine board: a caster PC acts first, a goblin is two cells from it (see seeding below).
  const areaFixture: { room?: Room; base?: string } = {};
  app.post('/api/test/reset-area', async (_request, reply) => {
    const room = areaFixture.room;
    const base = areaFixture.base;
    if (!room || !base)
      return reply.code(503).send({ error: 'area table not seeded' });
    await room.persistGameState(JSON.parse(base));
    return { ok: true };
  });
  app.post('/api/test/stage-reaction', async (request, reply) => {
    const reactionRoom = reactionFixture.room;
    const reactionBase = reactionFixture.base;
    if (!reactionRoom || !reactionBase)
      return reply.code(503).send({ error: 'reaction table not seeded' });
    const { accountId } = request.body as { accountId: string };
    const reactorId = seatEntityId(seatIdOf(reactionRoom, accountId));
    const game = JSON.parse(reactionBase) as PartyGame;
    const state = game.combatRoom as RoomCombatState;
    const goblinId = 'ent_goblin-minion_1';
    placeAdjacent(state, goblinId, reactorId);
    state.combat.activeEntityId = goblinId;
    const reactor = requireEntity(state, reactorId);
    const goblin = requireEntity(state, goblinId);
    // Turn-start resources, as combatEngine gives an entity when its turn begins.
    state.combat.resources[goblinId] = {
      ...state.combat.resources[goblinId]!,
      action: true,
      bonusAction: true,
      reaction: true,
      movementRemaining: goblin.speed ?? 30,
    };
    for (const dest of ringAround(goblin.pos)) {
      if (cheb(dest, reactor.pos) !== 2 || occupied(state, dest)) continue;
      // The path starts at the mover's own cell, then takes the one step.
      const moved = moveAlong(
        movementState(state, goblinId),
        goblinId,
        [goblin.pos, dest],
        'normal',
      );
      if ('error' in moved || moved.pending.length === 0) continue;
      const next = applyMovement(
        { ...state, phase: 'moving' },
        goblinId,
        moved.state,
        moved.pending,
        Date.now(),
      );
      await reactionRoom.persistGameState({ ...game, combatRoom: next });
      (
        reactionRoom as unknown as { scheduleReaction(): void }
      ).scheduleReaction();
      return { ok: true, reactorEntityId: reactorId };
    }
    return reply.code(409).send({ error: 'no reaction staging cell' });
  });

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
  const bindSheet = async (
    room: Room,
    account: Seated,
    sheet?: CharacterInput,
  ) => {
    const character =
      sheet ??
      ({
        ...quickBuild(catalog, undefined, sheetSeed++, 1).character,
        id: randomUUID(),
      } as CharacterInput);
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
  // Party sheets are keyed by account; reconcile rekeys them to ent_seat_<seatId> through the bindings.
  const combatGame = partyCombat(
    7,
    combatCharacters,
    combatRoom.seatCharacters,
  );
  // Fixture placement only: start_combat puts goblins far from the party. The goblin goes next to the
  // entity that acts first, so the spec's attack is in reach whichever seat wins initiative.
  const combatState = combatGame.combatRoom as RoomCombatState;
  placeAdjacent(
    combatState,
    'ent_goblin-minion_1',
    combatState.combat.activeEntityId ??
      combatState.combat.initiative[0]!.entityId,
  );
  await combatRoom.persistGameState(combatGame);
  combatFixture.room = combatRoom;
  combatFixture.base = JSON.stringify(combatGame);
  const combatEntity = (member: Seated) =>
    seatEntityId(seatIdOf(combatRoom, member.id));

  // The reaction table is its own encounter so the reaction spec never shares a board with the combat specs.
  const reactionHost = await seedAccount('Reaction Host');
  const reactionGuest = await seedAccount('Reaction Guest');
  const reactionScout = await seedAccount('Reaction Scout');
  const reactionMembers = [reactionHost, reactionGuest, reactionScout];
  const reaction = await openTable('Party reaction table', reactionHost, [
    reactionGuest,
    reactionScout,
  ]);
  const reactionRoom = await rooms.get(reaction.table);
  const reactionCharacters: Record<string, CharacterInput> = {};
  for (const member of reactionMembers)
    reactionCharacters[member.id] = await bindSheet(reactionRoom, member);
  const reactionGame = partyCombat(
    8,
    reactionCharacters,
    reactionRoom.seatCharacters,
  );
  await reactionRoom.persistGameState(reactionGame);
  // Each stage starts from this pristine board, so the goblin and the reactor always line up.
  reactionFixture.room = reactionRoom;
  reactionFixture.base = JSON.stringify(reactionGame);

  // The area table is its own encounter. The caster is a wizard with Burning Hands prepared (combatFixtures'
  // hero), so the engine lists cone aims for it. It acts first; the goblin stands two cells from it.
  const areaCaster = await seedAccount('Area Caster');
  const areaGuest = await seedAccount('Area Guest');
  const areaScout = await seedAccount('Area Scout');
  const area = await openTable('Party area table', areaCaster, [
    areaGuest,
    areaScout,
  ]);
  const areaRoom = await rooms.get(area.table);
  const areaCharacters: Record<string, CharacterInput> = {};
  // A valid quick-built wizard, with only Burning Hands prepared so the caster's aims are all Burning Hands.
  const wizard = quickBuild(catalog, 'class:wizard', sheetSeed++, 1).character;
  areaCharacters[areaCaster.id] = await bindSheet(areaRoom, areaCaster, {
    ...wizard,
    id: randomUUID(),
    spellsKnown: ['spell:burning-hands'],
    spellsPrepared: ['spell:burning-hands'],
  } as CharacterInput);
  for (const member of [areaGuest, areaScout])
    areaCharacters[member.id] = await bindSheet(areaRoom, member);
  const areaGame = partyCombat(9, areaCharacters, areaRoom.seatCharacters);
  const areaState = areaGame.combatRoom as RoomCombatState;
  const areaCasterId = seatEntityId(seatIdOf(areaRoom, areaCaster.id));
  placeTwoCellsAway(areaState, 'ent_goblin-minion_1', areaCasterId);
  // Turn-start resources for the caster, as combatEngine gives them when its turn begins.
  areaState.combat.activeEntityId = areaCasterId;
  areaState.combat.resources[areaCasterId] = {
    ...areaState.combat.resources[areaCasterId]!,
    action: true,
    bonusAction: true,
    reaction: true,
    movementRemaining: requireEntity(areaState, areaCasterId).speed ?? 30,
  };
  await areaRoom.persistGameState(areaGame);
  areaFixture.room = areaRoom;
  areaFixture.base = JSON.stringify(areaGame);

  // The late-join table: a solo host with a bound sheet, so a late joiner is admitted while the host plays alone. Its own table keeps the round specs' seating unchanged.
  const lateHost = await seedAccount('Late Host');
  const lateJoiner = await seedAccount('Late Joiner');
  await seats.saveOwnedCharacter(lateJoiner.id, {
    ...quickBuild(catalog, undefined, sheetSeed++, 1).character,
    id: randomUUID(),
  } as CharacterInput);
  const lateJoin = await openTable('Late join table', lateHost, []);
  const lateRoom = await rooms.get(lateJoin.table);
  const lateCharacters: Record<string, CharacterInput> = {};
  lateCharacters[lateHost.id] = await bindSheet(lateRoom, lateHost);
  const lateGame = preCombatGame(hero);
  await lateRoom.persistGameState({
    ...lateGame,
    characters: lateCharacters,
    // A story round has no battlemap. With one, admission takes the tactical spawn
    // path, which skips silently without a sceneId and never persists LateJoinAdmitted.
    gameEngine: { ...lateGame.gameEngine, map: undefined },
  });

  // The end-table table: ending it is destructive, so it gets its own table. Specs that
  // share the round table would otherwise see it closed by whichever spec runs first.
  const endHost = await seedAccount('End Host');
  const endGuest = await seedAccount('End Guest');
  const endTable = await openTable('Party end table', endHost, [endGuest]);
  const endRoom = await rooms.get(endTable.table);
  const endCharacters: Record<string, CharacterInput> = {};
  for (const member of [endHost, endGuest])
    endCharacters[member.id] = await bindSheet(endRoom, member);
  await endRoom.persistGameState({
    ...preCombatGame(hero),
    characters: endCharacters,
  });

  // The turn-timer table: the spec changes the timer, which other specs' round state would hide
  // the control behind. Its own host and table keep it independent of spec order.
  const timerHost = await seedAccount('Timer Host');
  const timerGuest = await seedAccount('Timer Guest');
  const timerTable = await openTable('Party turn timer table', timerHost, [
    timerGuest,
  ]);
  const timerRoom = await rooms.get(timerTable.table);
  const timerCharacters: Record<string, CharacterInput> = {};
  for (const member of [timerHost, timerGuest])
    timerCharacters[member.id] = await bindSheet(timerRoom, member);
  await timerRoom.persistGameState({
    ...preCombatGame(hero),
    characters: timerCharacters,
  });

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
      lateJoin: {
        table: lateJoin.table,
        invite: lateJoin.invite,
        host: { accountId: lateHost.id, token: lateHost.token },
        joiner: { accountId: lateJoiner.id, token: lateJoiner.token },
      },
      turnTimerTable: {
        table: timerTable.table,
        host: { accountId: timerHost.id, token: timerHost.token },
        guest: { accountId: timerGuest.id, token: timerGuest.token },
      },
      endTable: {
        table: endTable.table,
        invite: endTable.invite,
        host: { accountId: endHost.id, token: endHost.token },
        guest: { accountId: endGuest.id, token: endGuest.token },
      },
      area: {
        table: area.table,
        invite: area.invite,
        caster: {
          accountId: areaCaster.id,
          token: areaCaster.token,
          entityId: areaCasterId,
        },
        guest: {
          accountId: areaGuest.id,
          token: areaGuest.token,
          entityId: seatEntityId(seatIdOf(areaRoom, areaGuest.id)),
        },
        scout: {
          accountId: areaScout.id,
          token: areaScout.token,
          entityId: seatEntityId(seatIdOf(areaRoom, areaScout.id)),
        },
      },
      reaction: {
        table: reaction.table,
        invite: reaction.invite,
        host: {
          accountId: reactionHost.id,
          token: reactionHost.token,
          entityId: seatEntityId(seatIdOf(reactionRoom, reactionHost.id)),
        },
        guest: {
          accountId: reactionGuest.id,
          token: reactionGuest.token,
          entityId: seatEntityId(seatIdOf(reactionRoom, reactionGuest.id)),
        },
        scout: {
          accountId: reactionScout.id,
          token: reactionScout.token,
          entityId: seatEntityId(seatIdOf(reactionRoom, reactionScout.id)),
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
