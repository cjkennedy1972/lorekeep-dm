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
import { hashToken } from '../../src/accounts/signup.js';
import { Persistence } from '../../src/persistence/index.js';
import { RoomRegistry } from '../../src/room/registry.js';
import { SessionLease } from '../../src/room/lease.js';
import type { SoloTurnRunner } from '../../src/room/dmTurn.js';
import type { TurnResult } from '../../src/dm/orchestrator.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDatabase, type TestDatabase } from './testDb.js';
import { ProductionSoloTurnRunner } from '../../src/room/productionTurnRunner.js';
import {
  startFakeOpenAIServer,
  textStream,
  type FakeOpenAIServer,
} from '../llm/fakeOpenAIServer.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL required');
let testDatabase: TestDatabase;
let db: Pool;
let rooms: RoomRegistry;
let app: ReturnType<typeof createApp>;
let base = '';
const savedFixtureMode = process.env.LLM_FIXTURE_MODE;
const savedFixturePath = process.env.LLM_FIXTURE_PATH;
const savedNodeEnv = process.env.NODE_ENV;
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
async function createTable(ownerId: string) {
  const id = randomUUID();
  await db.query(
    'INSERT INTO sessions(id,owner_account_id,name) VALUES($1,$2,$3)',
    [id, ownerId, 'Solo table'],
  );
  sessionIds.push(id);
  await (await rooms.get(id)).seat(ownerId, 'Solo');
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
function receive(ws: WebSocket, predicate: (message: any) => boolean) {
  return new Promise<any>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('socket message timeout')),
      5000,
    );
    const handler = (data: WebSocket.RawData) => {
      const message = JSON.parse(data.toString());
      if (!predicate(message)) return;
      clearTimeout(timer);
      ws.off('message', handler);
      resolve(message);
    };
    ws.on('message', handler);
  });
}
function sendAction(ws: WebSocket, actionId: string, text: string) {
  ws.send(
    JSON.stringify({ type: 'PlayerAction', actionId, payload: { text } }),
  );
}
beforeAll(async () => {
  testDatabase = await createTestDatabase();
  db = testDatabase.pool;
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
});
afterAll(async () => {
  await rooms.drain();
  await app.close();
  for (const id of sessionIds)
    await db.query('DELETE FROM sessions WHERE id=$1', [id]);
  for (const id of accountIds)
    await db.query('DELETE FROM accounts WHERE id=$1', [id]);
  await fakeEndpoint?.close();
  await testDatabase.close();
  if (savedFixtureMode === undefined) delete process.env.LLM_FIXTURE_MODE;
  else process.env.LLM_FIXTURE_MODE = savedFixtureMode;
  if (savedFixturePath === undefined) delete process.env.LLM_FIXTURE_PATH;
  else process.env.LLM_FIXTURE_PATH = savedFixturePath;
  if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = savedNodeEnv;
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
    sendAction(reconnected, one, 'First action.');
    sendAction(reconnected, two, 'Second action.');
    const starts: string[] = [];
    reconnected.on('message', (data) => {
      const message = JSON.parse(data.toString());
      if (message.type === 'TurnThinking')
        starts.push(message.payload.actionId);
    });
    await receive(
      reconnected,
      (message) =>
        message.type === 'NarrationCompleted' &&
        message.payload?.turnId === one,
    );
    await receive(
      reconnected,
      (message) =>
        message.type === 'NarrationCompleted' &&
        message.payload?.turnId === two,
    );
    expect(starts.indexOf(two)).toBeGreaterThan(starts.indexOf(one));
    const latest = await new Persistence(db).loadLatest(table);
    expect(latest.snapshot?.state).toMatchObject({
      actionIds: expect.arrayContaining([actionId, one, two]),
    });
    reconnected.close();
  });

  it('replays the recorded-LLM fixture through the production runner over websocket', async () => {
    const owner = await createUser();
    const table = await createTable(owner.id);
    fakeEndpoint = await startFakeOpenAIServer({ chunks: textStream });
    await db.query(
      `INSERT INTO operator_endpoints(slot,base_url,model,api_style,encrypted_key,key_fingerprint,updated_at) VALUES('moderate',$1,'fixture-model','openai',NULL,NULL,now())`,
      [fakeEndpoint.baseUrl],
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
    rooms = tableRoomRegistry;
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

  it('discards an interrupted turn on room restart and permits resubmission', async () => {
    const owner = await createUser();
    const table = await createTable(owner.id);
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
    const actionId = randomUUID();
    expect(await room.submitAction(owner.id, actionId, 'Try the latch.')).toBe(
      true,
    );
    await started;
    const persistedBeforeRestart = await new Persistence(db).loadLatest(table);
    expect(JSON.stringify(persistedBeforeRestart)).not.toContain(actionId);
    await registry.drain();
    abandon();
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
    await new Promise((resolve) => setTimeout(resolve, 120));
    const afterRestart = await new Persistence(db).loadLatest(table);
    expect(afterRestart.snapshot?.state).toMatchObject({
      actionIds: expect.arrayContaining([actionId]),
    });
    await restarted.drain();
  });

  it('denies websocket tickets for a different table, even for a seated member', async () => {
    const firstOwner = await createUser();
    const secondOwner = await createUser();
    const firstTable = await createTable(firstOwner.id);
    const secondTable = await createTable(secondOwner.id);
    const firstToken = await createSession(db, firstOwner.id, 'wrong-table');
    await expect(
      issueTicket(db, firstOwner.id, secondTable, hashToken(firstToken)),
    ).rejects.toThrow();
    expect(firstTable).not.toBe(secondTable);
  });

  it('denies an unseated user and a client without a valid auth ticket', async () => {
    const owner = await createUser();
    const outsider = await createUser();
    const table = await createTable(owner.id);
    const rejected = await fetch(`${base}/api/ws-ticket`, {
      method: 'POST',
      headers: { origin: base, cookie: `sid=${outsider.token}` },
      body: JSON.stringify({ sessionId: table }),
    });
    expect(rejected.status).toBe(403);
    const anonymous = await fetch(`${base}/api/ws-ticket`, {
      method: 'POST',
      headers: { origin: base },
      body: JSON.stringify({ sessionId: table }),
    });
    expect(anonymous.status).toBe(401);
  });
});
