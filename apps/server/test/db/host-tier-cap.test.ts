import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LlmAdapter, LlmChunk } from '../../src/llm/adapter.js';
import { createApp } from '../../src/app.js';
import { createSession } from '../../src/accounts/sessions.js';
import { loadContentTierState } from '../../src/safety/tierLoader.js';
import { Persistence } from '../../src/persistence/index.js';
import { SessionLease, type Lease } from '../../src/room/lease.js';
import { Room, type Connection } from '../../src/room/Room.js';
import { RoomRegistry } from '../../src/room/registry.js';
import { ProductionSoloTurnRunner } from '../../src/room/productionTurnRunner.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL required');
let db: Pool;
let dir: string;

beforeAll(async () => {
  db = new Pool({ connectionString: databaseUrl });
  dir = await mkdtemp(join(tmpdir(), 'host-tier-cap-'));
});
afterAll(async () => {
  await db.end();
  await rm(dir, { recursive: true, force: true });
});

type Sent = { type: string; payload?: unknown };
const recorder = () => {
  const sent: Sent[] = [];
  const connection: Connection = {
    send: (message) => sent.push(message as Sent),
  };
  return { sent, connection };
};

async function account(optOut = false) {
  const id = randomUUID();
  await db.query(
    `INSERT INTO accounts(id,email,password_hash,display_name,status,is_adult,age_checked_at,terms_version,terms_accepted_at,mature_opt_out)
     VALUES($1,$2,'hash','Host',  'active',true,now(),'v1',now(),$3)`,
    [id, `${id}@example.test`, optOut],
  );
  return id;
}

async function table(host: string) {
  const sessionId = randomUUID();
  await db.query(
    `INSERT INTO sessions(id,owner_account_id,name,moderation_verified,content_tier)
     VALUES($1,$2,'Cap table',true,'standard')`,
    [sessionId, host],
  );
  await db.query(
    `INSERT INTO events(session_id,seq,turn_id,type,payload) VALUES($1,1,$2,'SeatJoined',$3)`,
    [
      sessionId,
      randomUUID(),
      {
        seatId: randomUUID(),
        accountId: host,
        displayName: 'Host',
        presence: 'offline',
        matureOptOut: false,
      },
    ],
  );
  return sessionId;
}

/** Leaves a session_lease row behind, as any table that has ever been opened does. */
async function openedBefore(sessionId: string) {
  const leases = new SessionLease(db);
  const lease = await leases.acquire(sessionId, randomUUID());
  if (!lease) throw new Error('lease unavailable');
  await leases.release(lease);
}

function narrator() {
  const adapter: LlmAdapter = {
    capabilities: () => ({
      streaming: true,
      nativeTools: true,
      jsonSchema: true,
    }),
    probe: async () => true,
    async *complete() {
      yield { type: 'text', delta: 'The torch gutters.' } as LlmChunk;
    },
  };
  return adapter;
}

function runner() {
  return new ProductionSoloTurnRunner(
    db,
    undefined,
    'record',
    join(dir, `${randomUUID()}.ndjson`),
    narrator(),
    false,
    true,
  );
}

async function waitForNarrations(sessionId: string, count: number) {
  for (let i = 0; i < 300; i++) {
    const { rows } = await db.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM events WHERE session_id=$1 AND type='NarrationCompleted'",
      [sessionId],
    );
    if (Number(rows[0]?.n) >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('narration did not complete');
}

const capOf = async (sessionId: string) =>
  (
    await db.query<{ host_tier_cap: string | null }>(
      'SELECT host_tier_cap FROM sessions WHERE id=$1',
      [sessionId],
    )
  ).rows[0]?.host_tier_cap;

const storedTier = async (sessionId: string) =>
  (
    await db.query<{ content_tier: string }>(
      'SELECT content_tier FROM sessions WHERE id=$1',
      [sessionId],
    )
  ).rows[0]?.content_tier;

async function expectContiguousLog(sessionId: string) {
  const { rows } = await db.query<{ seq: string }>(
    'SELECT seq FROM events WHERE session_id=$1 ORDER BY seq',
    [sessionId],
  );
  expect(rows.map((row) => Number(row.seq))).toEqual(
    rows.map((_, index) => index + 1),
  );
}

const patchCap = (
  app: ReturnType<typeof createApp>,
  sessionId: string,
  token: string,
  tier: unknown,
) =>
  app.inject({
    method: 'PATCH',
    url: `/api/sessions/${sessionId}/content-tier`,
    remoteAddress: '10.8.0.1',
    headers: { cookie: `sid=${token}` },
    payload: { tier },
  });

describe('host tier cap', () => {
  it('lowers the cap on a table whose lease row already exists, and the cap holds through the next narration', async () => {
    const host = await account();
    const token = await createSession(db, host, 'Host device');
    const sessionId = await table(host);
    await openedBefore(sessionId);
    const app = createApp(db, { cookieSecret: 'test-secret' });

    const response = await patchCap(app, sessionId, token, 'family');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ tier: 'family' });
    expect(await capOf(sessionId)).toBe('family');
    const lease = await db.query<{ live: boolean }>(
      "SELECT expires_at > clock_timestamp() AS live FROM session_lease WHERE session_id=$1 AND node_id=''",
      [sessionId],
    );
    expect(lease.rows).toEqual([{ live: false }]);

    const held = await new SessionLease(db).acquire(sessionId, 'next-turn');
    if (!held) throw new Error('lease unavailable');
    const room = new Room(
      new Persistence(db),
      held,
      await new Persistence(db).loadLatest(sessionId),
      runner(),
    );
    const seen = recorder();
    await room.join(host, seen.connection, 'Host');
    expect(await room.submitAction(host, randomUUID(), 'Look.', 'Host')).toBe(
      true,
    );
    await waitForNarrations(sessionId, 1);

    expect(await storedTier(sessionId)).toBe('family');
    expect(
      seen.sent.filter((message) => message.type === 'ContentTierChanged'),
    ).toHaveLength(1);
    await expectContiguousLog(sessionId);
    await new SessionLease(db).release(held);
    await app.close();
  });

  it('a live Room takes the cap change and the next player action succeeds with one ContentTierChanged', async () => {
    const host = await account();
    const token = await createSession(db, host, 'Host device');
    const sessionId = await table(host);
    const rooms = new RoomRegistry(
      new Persistence(db),
      new SessionLease(db),
      'node-live-cap',
      undefined,
      undefined,
      runner(),
    );
    const room = await rooms.get(sessionId);
    const seen = recorder();
    await room.join(host, seen.connection, 'Host');
    const app = createApp(db, { cookieSecret: 'test-secret', rooms });

    const response = await patchCap(app, sessionId, token, 'family');
    expect(response.statusCode).toBe(200);
    expect(await room.submitAction(host, randomUUID(), 'Look.', 'Host')).toBe(
      true,
    );
    await waitForNarrations(sessionId, 1);

    expect(await capOf(sessionId)).toBe('family');
    expect(await storedTier(sessionId)).toBe('family');
    expect(
      seen.sent.filter((message) => message.type === 'ContentTierChanged'),
    ).toHaveLength(1);
    await expectContiguousLog(sessionId);
    await app.close();
    await rooms.drain();
  });

  it('a cap change racing a player action keeps the event log contiguous', async () => {
    const host = await account();
    const token = await createSession(db, host, 'Host device');
    const sessionId = await table(host);
    const rooms = new RoomRegistry(
      new Persistence(db),
      new SessionLease(db),
      'node-race-cap',
      undefined,
      undefined,
      runner(),
    );
    const room = await rooms.get(sessionId);
    await room.join(host, recorder().connection, 'Host');
    const app = createApp(db, { cookieSecret: 'test-secret', rooms });

    const [response, accepted] = await Promise.all([
      patchCap(app, sessionId, token, 'family'),
      room.submitAction(host, randomUUID(), 'Look.', 'Host'),
    ]);
    expect(response.statusCode).toBe(200);
    expect(accepted).toBe(true);
    await waitForNarrations(sessionId, 1);

    expect(await room.submitAction(host, randomUUID(), 'Listen.', 'Host')).toBe(
      true,
    );
    await waitForNarrations(sessionId, 2);
    expect(await capOf(sessionId)).toBe('family');
    expect(await storedTier(sessionId)).toBe('family');
    await expectContiguousLog(sessionId);
    await app.close();
    await rooms.drain();
  });

  it('clears the cap so the next narration returns to the computed tier', async () => {
    const host = await account();
    const token = await createSession(db, host, 'Host device');
    const sessionId = await table(host);
    await openedBefore(sessionId);
    const app = createApp(db, { cookieSecret: 'test-secret' });

    expect((await patchCap(app, sessionId, token, 'family')).statusCode).toBe(
      200,
    );
    const cleared = await patchCap(app, sessionId, token, null);
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toEqual({ tier: null });
    expect(await capOf(sessionId)).toBeNull();
    expect((await loadContentTierState(db, sessionId, true)).tier).toBe(
      'mature',
    );
    await app.close();
  });

  it('never raises the tier above a player opt-out, with or without a cap', async () => {
    const host = await account();
    const token = await createSession(db, host, 'Host device');
    const sessionId = await table(host);
    const player = await account(true);
    await db.query(
      `INSERT INTO events(session_id,seq,turn_id,type,payload) VALUES($1,2,$2,'SeatJoined',$3)`,
      [
        sessionId,
        randomUUID(),
        {
          seatId: randomUUID(),
          accountId: player,
          displayName: 'Player',
          presence: 'offline',
          matureOptOut: true,
        },
      ],
    );
    await openedBefore(sessionId);
    const app = createApp(db, { cookieSecret: 'test-secret' });

    expect((await patchCap(app, sessionId, token, 'standard')).statusCode).toBe(
      200,
    );
    expect((await loadContentTierState(db, sessionId, true)).tier).toBe(
      'standard',
    );
    expect((await patchCap(app, sessionId, token, null)).statusCode).toBe(200);
    expect((await loadContentTierState(db, sessionId, true)).tier).toBe(
      'standard',
    );
    await app.close();
  });

  it('answers 409 retryable when another node holds the session lease, and writes nothing', async () => {
    const host = await account();
    const token = await createSession(db, host, 'Host device');
    const sessionId = await table(host);
    const held: Lease | null = await new SessionLease(db).acquire(
      sessionId,
      'other-node',
    );
    if (!held) throw new Error('lease unavailable');
    const app = createApp(db, { cookieSecret: 'test-secret' });

    const response = await patchCap(app, sessionId, token, 'family');
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      code: 'SESSION_BUSY',
      retryable: true,
    });
    expect(await capOf(sessionId)).toBeNull();
    const audit = await db.query(
      "SELECT 1 FROM events WHERE session_id=$1 AND type='HostTierCapChanged'",
      [sessionId],
    );
    expect(audit.rows).toEqual([]);
    await new SessionLease(db).release(held);
    await app.close();
  });
});
