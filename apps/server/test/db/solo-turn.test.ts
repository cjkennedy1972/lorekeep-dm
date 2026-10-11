import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import WebSocket from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { createSession } from '../../src/accounts/sessions.js';
import { installGateway } from '../../src/gateway/ws.js';
import { ConnectionRegistry } from '../../src/gateway/connections.js';
import { issueTicket } from '../../src/gateway/tickets.js';
import { hashToken } from '../../src/accounts/signup.js';
import { createEndpointEgress, saveEndpoint } from '../../src/llm/config.js';
import { Persistence } from '../../src/persistence/index.js';
import { RoomRegistry } from '../../src/room/registry.js';
import { SessionLease } from '../../src/room/lease.js';
import type { SoloTurnRunner } from '../../src/room/dmTurn.js';
import { RegistryMemory } from '../../src/dm/memory.js';
import { loadCatalog, catalogVersionOf } from '@game/rules-engine/catalog-node';
import type { TurnResult } from '../../src/dm/orchestrator.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProductionSoloTurnRunner } from '../../src/room/productionTurnRunner.js';
import {
  startFakeOpenAIServer,
  textStream,
  type FakeOpenAIServer,
} from '../llm/fakeOpenAIServer.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL required');
let db: Pool;
let rooms: RoomRegistry;
let app: ReturnType<typeof createApp>;
let base = '';
const savedFixtureMode = process.env.LLM_FIXTURE_MODE;
const savedFixturePath = process.env.LLM_FIXTURE_PATH;
const savedNodeEnv = process.env.NODE_ENV;
const savedAllowLocalHosts = process.env.LLM_ALLOW_LOCAL_HOSTS;
let fakeEndpoint: FakeOpenAIServer | undefined;
const accountIds: string[] = [];
const sessionIds: string[] = [];
const runner: SoloTurnRunner = {
  async run(request, emit) {
    await new Promise((resolve) => setTimeout(resolve, 80));
    emit({
      type: 'NarrationChunk',
      turnId: request.actionId,
      text: 'The door opens.',
      index: 0,
    });
    // The real orchestrator emits this before returning; the Room forwards it to clients.
    emit({
      type: 'NarrationCompleted',
      turnId: request.actionId,
      text: 'The door opens.',
      words: 3,
    });
    return {
      narration: 'The door opens.',
      events: [{ type: 'TurnStarted', turnId: request.actionId }],
      state: {
        ...((request.state ?? {}) as object),
        committed: request.actionId,
      },
      turnSeed: '0x0000000000000000',
      usage: { in: 1, out: 1 },
    } satisfies TurnResult;
  },
};
async function createUser() {
  const id = randomUUID();
  await db.query(
    `INSERT INTO accounts(id,email,password_hash,display_name,status,is_adult,age_checked_at,terms_version,terms_accepted_at) VALUES($1,$2,'hash','Solo','active',true,now(),'v1',now())`,
    [id, `${id}@example.test`],
  );
  accountIds.push(id);
  return { id, token: await createSession(db, id, 'solo-turn-test') };
}
async function createTable(ownerId: string, seat = true) {
  const id = randomUUID();
  await db.query(
    'INSERT INTO sessions(id,owner_account_id,name) VALUES($1,$2,$3)',
    [id, ownerId, 'Solo table'],
  );
  sessionIds.push(id);
  if (seat) await (await rooms.get(id)).seat(ownerId, 'Solo');
  return id;
}
async function openSocket(accountId: string, token: string, sessionId: string) {
  const ticket = await issueTicket(db, accountId, sessionId, hashToken(token));
  const ws = new WebSocket(
    `${base.replace('http', 'ws')}/ws?ticket=${ticket}`,
    { origin: base },
  );
  await new Promise<void>((resolve, reject) => {
    ws.once('message', () => resolve());
    ws.once('error', reject);
  });
  return ws;
}
type WireMessage = {
  type: string;
  payload?: Record<string, unknown>;
};
function receive(
  ws: WebSocket,
  predicate: (message: WireMessage) => boolean,
): Promise<WireMessage> {
  return new Promise<WireMessage>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('socket message timeout')),
      5000,
    );
    const handler = (data: WebSocket.RawData) => {
      const message = JSON.parse(data.toString()) as WireMessage;
      if (!predicate(message)) return;
      clearTimeout(timer);
      ws.off('message', handler);
      resolve(message);
    };
    ws.on('message', handler);
  });
}
/** The orchestrator emits NarrationCompleted before the Room commits the turn, so wait for the commit. */
async function committedState(
  table: string,
  ready: (state: Record<string, unknown>) => boolean,
) {
  const deadline = Date.now() + 3000;
  for (;;) {
    const latest = await new Persistence(db).loadLatest(table);
    const state = (latest.snapshot?.state ?? {}) as Record<string, unknown>;
    if (ready(state) || Date.now() > deadline) return state;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
function sendAction(ws: WebSocket, actionId: string, text: string) {
  ws.send(
    JSON.stringify({
      type: 'PlayerAction',
      actionId,
      lastSeq: 0,
      payload: { text },
    }),
  );
}
beforeAll(async () => {
  db = new Pool({ connectionString: databaseUrl });
  rooms = new RoomRegistry(
    new Persistence(db),
    new SessionLease(db),
    'solo-turn-db',
    600_000,
    60_000,
    runner,
  );
  const connections = new ConnectionRegistry(db);
  app = createApp(db, { rooms, connections });
  installGateway(app, db, rooms, connections, 300);
  base = await app.listen({ host: '127.0.0.1', port: 0 });
  process.env.NODE_ENV = 'test';
  process.env.LLM_FIXTURE_MODE = 'strict';
  process.env.LLM_ALLOW_LOCAL_HOSTS = '127.0.0.1';
});
afterAll(async () => {
  await rooms.drain();
  await app.close();
  for (const id of sessionIds) await db.query('SELECT purge_session($1)', [id]); // events are append-only; this is the sanctioned removal
  for (const id of accountIds)
    await db.query('DELETE FROM accounts WHERE id=$1', [id]);
  await db.query("DELETE FROM operator_endpoints WHERE slot='moderate'");
  await fakeEndpoint?.close();
  await db.end();
  if (savedFixtureMode === undefined) delete process.env.LLM_FIXTURE_MODE;
  else process.env.LLM_FIXTURE_MODE = savedFixtureMode;
  if (savedFixturePath === undefined) delete process.env.LLM_FIXTURE_PATH;
  else process.env.LLM_FIXTURE_PATH = savedFixturePath;
  if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = savedNodeEnv;
  if (savedAllowLocalHosts === undefined)
    delete process.env.LLM_ALLOW_LOCAL_HOSTS;
  else process.env.LLM_ALLOW_LOCAL_HOSTS = savedAllowLocalHosts;
});

describe('solo turn persisted lifecycle', () => {
  it('deduplicates across reconnect and serializes one in-flight turn per table', async () => {
    const owner = await createUser();
    const table = await createTable(owner.id);
    const first = await openSocket(owner.id, owner.token, table);
    const actionId = randomUUID();
    sendAction(first, actionId, 'Open the door.');
    await receive(first, (message) => message.type === 'NarrationCompleted');
    first.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const reconnected = await openSocket(owner.id, owner.token, table);
    sendAction(reconnected, actionId, 'Open the door again.');
    await receive(
      reconnected,
      (message) => message.payload?.code === 'DUPLICATE_ACTION',
    );
    const one = randomUUID();
    const two = randomUUID();
    const starts: string[] = [];
    reconnected.on('message', (data) => {
      const message = JSON.parse(data.toString()) as WireMessage;
      if (message.type === 'TurnThinking')
        starts.push(String(message.payload?.actionId));
    });
    // Register every wait before sending: both completions can arrive in one network chunk,
    // so a wait registered after the first resolves would miss the second.
    const completedOne = receive(
      reconnected,
      (message) =>
        message.type === 'NarrationCompleted' &&
        message.payload?.turnId === one,
    );
    const completedTwo = receive(
      reconnected,
      (message) =>
        message.type === 'NarrationCompleted' &&
        message.payload?.turnId === two,
    );
    sendAction(reconnected, one, 'First action.');
    sendAction(reconnected, two, 'Second action.');
    await Promise.all([completedOne, completedTwo]);
    expect(starts.indexOf(two)).toBeGreaterThan(starts.indexOf(one));
    const state = await committedState(table, (value) =>
      ((value.actionIds as string[] | undefined) ?? []).includes(two),
    );
    expect(state).toMatchObject({
      actionIds: expect.arrayContaining([actionId, one, two]),
    });
    reconnected.close();
  });

  it('replays the recorded-LLM fixture through the production runner over websocket', async () => {
    const owner = await createUser();
    fakeEndpoint = await startFakeOpenAIServer({ chunks: textStream });
    process.env.LLM_ALLOW_LOCAL_HOSTS = new URL(fakeEndpoint.baseUrl).host;
    await saveEndpoint(
      db,
      'moderate',
      {
        baseUrl: fakeEndpoint.baseUrl,
        model: 'fixture-model',
        apiStyle: 'openai',
        apiKey: 'fixture-secret',
        unsupportedToolSchemaKeywords: [],
      },
      createEndpointEgress(),
      owner.id,
    );
    process.env.LLM_FIXTURE_MODE = 'record';
    const fixtureDir = await mkdtemp(join(tmpdir(), 'solo-turn-fixture-'));
    process.env.LLM_FIXTURE_PATH = join(fixtureDir, 'turn.ndjson');
    const production = new ProductionSoloTurnRunner(db);
    const tableRoomRegistry = new RoomRegistry(
      new Persistence(db),
      new SessionLease(db),
      'recorded-websocket',
      600_000,
      60_000,
      production,
    );
    const priorRooms = rooms;
    // The table must be created through the registry the websocket uses: it holds the session lease.
    rooms = tableRoomRegistry;
    const table = await createTable(owner.id);
    const connections = new ConnectionRegistry(db);
    const recordedApp = createApp(db, { rooms, connections });
    installGateway(recordedApp, db, rooms, connections, 300);
    const recordedBase = await recordedApp.listen({
      host: '127.0.0.1',
      port: 0,
    });
    const token = await createSession(db, owner.id, 'recorded-solo');
    const ticket = await issueTicket(db, owner.id, table, hashToken(token));
    const ws = new WebSocket(
      `${recordedBase.replace('http', 'ws')}/ws?ticket=${ticket}`,
      { origin: recordedBase },
    );
    await new Promise<void>((resolve, reject) => {
      ws.once('message', () => resolve());
      ws.once('error', reject);
    });
    const completed = receive(
      ws,
      (message) => message.type === 'NarrationCompleted',
    );
    sendAction(ws, randomUUID(), 'Look at the old door.');
    await expect(completed).resolves.toMatchObject({
      type: 'NarrationCompleted',
      payload: { text: 'hello world' },
    });
    ws.close();
    await rooms.drain();
    await recordedApp.close();
    rooms = priorRooms;
    expect(fakeEndpoint.requests).toHaveLength(1);
    await db.query("DELETE FROM operator_endpoints WHERE slot='moderate'");
    await rm(fixtureDir, { recursive: true, force: true });
    delete process.env.LLM_FIXTURE_PATH;
  });

  it('persists scene transitions in events and snapshot across room restart', async () => {
    const owner = await createUser();
    const table = await createTable(owner.id, false);
    const sceneRunner = (targetScene: string): SoloTurnRunner => ({
      async run(request) {
        const initial = request.state as Record<string, unknown>;
        const first = initial.sceneId === 'scene-marowfell-well';
        const target = first ? 'scene-broken-gatehouse' : undefined;
        return {
          narration: 'The scene closes.',
          events: [
            { type: 'TurnStarted', turnId: request.actionId },
            {
              type: 'SceneClosed',
              sceneId: first ? 'scene-marowfell-well' : targetScene,
              summary: 'The scene closed.',
              ...(target ? { nextSceneId: target } : { nextSceneId: null }),
            },
          ],
          state: {
            ...initial,
            ...(target ? { sceneId: target } : { adventureCompleted: true }),
          },
          turnSeed: '0x0000000000000000',
          usage: { in: 0, out: 0 },
        } satisfies TurnResult;
      },
    });
    const registry = new RoomRegistry(
      new Persistence(db),
      new SessionLease(db),
      'scene-transition-test',
      600_000,
      60_000,
      sceneRunner('scene-lamp-vault'),
    );
    const room = await registry.get(table);
    await room.seat(owner.id, 'Solo');
    await room.persistGameState({
      sceneId: 'scene-marowfell-well',
      adventureId: 'adventure:01-hollow-under-marrowfell',
    });
    const actionId = randomUUID();
    expect(
      await room.submitAction(owner.id, actionId, 'Continue onward.'),
    ).toBe(true);
    const firstState = await committedState(table, (value) =>
      ((value.actionIds as string[] | undefined) ?? []).includes(actionId),
    );
    expect(firstState.gameState).toMatchObject({
      sceneId: 'scene-broken-gatehouse',
    });
    const event = await db.query(
      "SELECT payload FROM events WHERE session_id=$1 AND type='SceneClosed' ORDER BY seq DESC LIMIT 1",
      [table],
    );
    expect(event.rows[0]?.payload).toMatchObject({
      nextSceneId: 'scene-broken-gatehouse',
    });
    await registry.drain();

    const restarted = new RoomRegistry(
      new Persistence(db),
      new SessionLease(db),
      'scene-transition-restarted',
      600_000,
      60_000,
      sceneRunner('scene-lamp-vault'),
    );
    const resumed = await restarted.get(table);
    expect(resumed.state.gameState).toMatchObject({
      sceneId: 'scene-broken-gatehouse',
    });
    expect(await resumed.submitAction(owner.id, randomUUID(), 'Finish.')).toBe(
      true,
    );
    const finalState = await committedState(
      table,
      (value) =>
        (value.gameState as Record<string, unknown> | undefined)
          ?.adventureCompleted === true,
    );
    expect(finalState.gameState).toMatchObject({ adventureCompleted: true });
    await restarted.drain();
  });

  it('discards an interrupted turn on room restart and permits resubmission', async () => {
    const owner = await createUser();
    const table = await createTable(owner.id, false);
    let entered!: () => void;
    let abandon!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked: SoloTurnRunner = {
      async run() {
        entered();
        await new Promise<void>((resolve) => {
          abandon = resolve;
        });
        throw new Error('simulated process loss');
      },
    };
    const registry = new RoomRegistry(
      new Persistence(db),
      new SessionLease(db),
      'interrupted-turn',
      600_000,
      60_000,
      blocked,
    );
    const room = await registry.get(table);
    await room.seat(owner.id, 'Solo');
    const actionId = randomUUID();
    expect(await room.submitAction(owner.id, actionId, 'Try the latch.')).toBe(
      true,
    );
    await started;
    const persistedBeforeRestart = await new Persistence(db).loadLatest(table);
    expect(JSON.stringify(persistedBeforeRestart)).not.toContain(actionId);
    abandon();
    await registry.drain();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const restarted = new RoomRegistry(
      new Persistence(db),
      new SessionLease(db),
      'restart-turn',
      600_000,
      60_000,
      runner,
    );
    const recovered = await restarted.get(table);
    expect(
      await recovered.submitAction(owner.id, actionId, 'Try the latch again.'),
    ).toBe(true);
    const afterRestart = await committedState(table, (value) =>
      ((value.actionIds as string[] | undefined) ?? []).includes(actionId),
    );
    expect(afterRestart).toMatchObject({
      actionIds: expect.arrayContaining([actionId]),
    });
    const memory = new RegistryMemory(db);
    expect(await memory.entities(table)).toEqual([]);
    await restarted.drain();
  });

  it('denies websocket tickets for a different table, even for a seated member', async () => {
    const firstOwner = await createUser();
    const secondOwner = await createUser();
    const firstTable = await createTable(firstOwner.id);
    const secondTable = await createTable(secondOwner.id);
    const firstToken = await createSession(db, firstOwner.id, 'wrong-table');
    const rejected = await fetch(`${base}/api/ws-ticket`, {
      method: 'POST',
      headers: {
        origin: base,
        cookie: `sid=${firstToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ sessionId: secondTable }),
    });
    expect(rejected.status).toBe(403);
    expect(await rejected.json()).toEqual({ error: 'not seated' });
    expect(firstTable).not.toBe(secondTable);
    // Positive control: the same request for the member's own table succeeds, so the 403
    // above is the authorization decision and not a parsing or setup artifact.
    const allowed = await fetch(`${base}/api/ws-ticket`, {
      method: 'POST',
      headers: {
        origin: base,
        cookie: `sid=${firstToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ sessionId: firstTable }),
    });
    expect(allowed.status).toBe(200);
  });

  it('denies an unseated user and a client without a valid auth ticket', async () => {
    const owner = await createUser();
    const outsider = await createUser();
    const table = await createTable(owner.id);
    const rejected = await fetch(`${base}/api/ws-ticket`, {
      method: 'POST',
      headers: {
        origin: base,
        cookie: `sid=${outsider.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ sessionId: table }),
    });
    expect(rejected.status).toBe(403);
    expect(await rejected.json()).toEqual({ error: 'not seated' });
    const anonymous = await fetch(`${base}/api/ws-ticket`, {
      method: 'POST',
      headers: { origin: base, 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: table }),
    });
    expect(anonymous.status).toBe(401);
  });

  it('creates through first narration within three minutes and resumes after restart on another device with owner isolation', async () => {
    const owner = await createUser();
    const startedAt = performance.now();
    const created = await fetch(`${base}/api/tables`, {
      method: 'POST',
      headers: {
        origin: base,
        cookie: `sid=${owner.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'Lifecycle proof' }),
    });
    expect(created.status).toBe(201);
    const createdAt = performance.now();
    const gameId = (await created.json()).game.id as string;
    sessionIds.push(gameId);
    const pinned = await db.query<{
      catalog_snapshot: unknown;
      catalog_version: string;
    }>(
      'SELECT cs.entries AS catalog_snapshot,s.catalog_version FROM sessions s JOIN catalog_snapshots cs ON cs.catalog_version=s.catalog_version WHERE s.id=$1',
      [gameId],
    );
    const currentCatalog = loadCatalog();
    expect(pinned.rows[0]?.catalog_snapshot).toEqual(currentCatalog.entries);
    expect(pinned.rows[0]?.catalog_version).toBe(currentCatalog.catalogVersion);
    const historicalEntries = currentCatalog.entries.map((entry, index) =>
      index === 0 && 'name' in entry
        ? { ...entry, name: `${entry.name} (pinned before catalog update)` }
        : entry,
    );
    const historicalVersion = catalogVersionOf(historicalEntries);
    await db.query(
      'INSERT INTO catalog_snapshots(catalog_version,entries) VALUES($1,$2::jsonb) ON CONFLICT DO NOTHING',
      [historicalVersion, JSON.stringify(historicalEntries)],
    );
    await db.query('UPDATE sessions SET catalog_version=$2 WHERE id=$1', [
      gameId,
      historicalVersion,
    ]);
    const roomAtCreation = await rooms.get(gameId);
    const initialGameState = roomAtCreation.state.gameState as Record<
      string,
      unknown
    >;
    await roomAtCreation.persistGameState({
      ...initialGameState,
      catalogVersion: historicalVersion,
    });

    const socket = await openSocket(owner.id, owner.token, gameId);
    const connectedAt = performance.now();
    const firstNarration = receive(
      socket,
      (message) => message.type === 'NarrationCompleted',
    );
    sendAction(socket, randomUUID(), 'I look toward the village lantern.');
    const narration = await firstNarration;
    const narratedAt = performance.now();
    socket.close();
    expect(narration.payload?.text).toBe('The door opens.');
    expect(narratedAt - startedAt).toBeLessThanOrEqual(180_000);
    process.stdout.write(
      `M2-28 scripted timing ms: create=${Math.round(createdAt - startedAt)}; websocket=${Math.round(connectedAt - createdAt)}; first-narration=${Math.round(narratedAt - connectedAt)}; total=${Math.round(narratedAt - startedAt)} (limit=180000)\n`,
    );

    await new RegistryMemory(db).closeScene(
      gameId,
      'scene:opening',
      'The adventurer followed the lantern light into Greyfen and found the road abandoned.',
    );
    const beforeRestart = await fetch(`${base}/api/tables/${gameId}`, {
      headers: { cookie: `sid=${owner.token}` },
    });
    expect(beforeRestart.status).toBe(200);
    const priorGame = (await beforeRestart.json()).game;
    expect(priorGame.recap).toContain('followed the lantern light');
    const priorCharacter = priorGame.character;
    const priorGameState = priorGame.state.gameState;

    await rooms.drain();
    await app.close();
    rooms = new RoomRegistry(
      new Persistence(db),
      new SessionLease(db),
      'solo-turn-restarted',
      600_000,
      60_000,
      runner,
    );
    const connections = new ConnectionRegistry(db);
    app = createApp(db, { rooms, connections });
    installGateway(app, db, rooms, connections, 300);
    base = await app.listen({ host: '127.0.0.1', port: 0 });

    const secondDeviceToken = await createSession(
      db,
      owner.id,
      'second-device',
    );
    const resumed = await fetch(`${base}/api/tables/${gameId}`, {
      headers: { cookie: `sid=${secondDeviceToken}` },
    });
    expect(resumed.status).toBe(200);
    const resumedGame = (await resumed.json()).game;
    expect(resumedGame.character).toEqual(priorCharacter);
    const priorStateWithoutRecap = {
      ...(priorGameState as Record<string, unknown>),
    };
    const resumedStateWithoutRecap = {
      ...(resumedGame.state.gameState as Record<string, unknown>),
    };
    delete priorStateWithoutRecap.recap;
    delete resumedStateWithoutRecap.recap;
    expect(resumedStateWithoutRecap).toEqual(priorStateWithoutRecap);
    expect(resumedGame.recap).toContain('followed the lantern light');

    const outsider = await createUser();
    const forbidden = await fetch(`${base}/api/tables/${gameId}`, {
      headers: { cookie: `sid=${outsider.token}` },
    });
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toMatchObject({ code: 'FORBIDDEN' });
  });

  it('second unchanged resume makes zero metered LLM calls', async () => {
    const owner = await createUser();
    const table = await createTable(owner.id);
    await db.query(
      'UPDATE sessions SET mode=$2,catalog_version=$3,premise=$4 WHERE id=$1',
      [table, 'solo', loadCatalog().catalogVersion, 'A quiet road.'],
    );
    const token = await createSession(db, owner.id, 'resume-test');
    const before = await db.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM endpoint_usage WHERE session_id=$1',
      [table],
    );
    const first = await fetch(`${base}/api/tables/${table}`, {
      headers: { cookie: `sid=${token}` },
    });
    expect(first.status).toBe(200);
    const second = await fetch(`${base}/api/tables/${table}`, {
      headers: { cookie: `sid=${token}` },
    });
    expect(second.status).toBe(200);
    const after = await db.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM endpoint_usage WHERE session_id=$1',
      [table],
    );
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
  });
});
