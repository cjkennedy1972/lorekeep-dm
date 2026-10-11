import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LlmAdapter, LlmChunk } from '../../src/llm/adapter.js';
import { Persistence } from '../../src/persistence/index.js';
import { SessionLease } from '../../src/room/lease.js';
import { Room, type Connection } from '../../src/room/Room.js';
import { ProductionSoloTurnRunner } from '../../src/room/productionTurnRunner.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL required');
let db: Pool;
let dir: string;

type Sent = { type: string; payload?: unknown };
const recorder = () => {
  const sent: Sent[] = [];
  const connection: Connection = {
    send: (message) => sent.push(message as Sent),
  };
  return { sent, connection };
};
const narrationText = (sent: Sent[]) =>
  sent
    .filter((m) => m.type === 'NarrationChunk')
    .map((m) => m.payload as { delta?: string; text?: string })
    .map((payload) => payload.delta ?? payload.text ?? '')
    .join('');

async function account(optOut: boolean, status = 'active') {
  const id = randomUUID();
  await db.query(
    `INSERT INTO accounts(id,email,password_hash,display_name,status,is_adult,age_checked_at,terms_version,terms_accepted_at,mature_opt_out)
     VALUES($1,$2,'hash','Player',$3,true,now(),'v1',now(),$4)`,
    [id, `${id}@example.test`, status, optOut],
  );
  return id;
}

async function session(owner: string) {
  const id = randomUUID();
  await db.query(
    'INSERT INTO sessions(id,owner_account_id,name,moderation_verified) VALUES($1,$2,$3,true)',
    [id, owner, 'Room tier'],
  );
  return id;
}

/** Streams two chunks with `between` running after the first, so the test can change state mid-stream. */
function twoChunkNarrator(between: () => Promise<void>) {
  const adapter: LlmAdapter = {
    capabilities: () => ({
      streaming: true,
      nativeTools: true,
      jsonSchema: true,
    }),
    probe: async () => true,
    async *complete() {
      yield { type: 'text', delta: 'The torch ' } as LlmChunk;
      await between();
      yield { type: 'text', delta: 'gutters.' } as LlmChunk;
    },
  };
  return adapter;
}

const LONG_NARRATION =
  'The torch gutters low over the stone. Shadows lengthen along the hall.';

function singleTextNarrator(text: string) {
  const adapter: LlmAdapter = {
    capabilities: () => ({
      streaming: true,
      nativeTools: true,
      jsonSchema: true,
    }),
    probe: async () => true,
    async *complete() {
      yield { type: 'text', delta: text } as LlmChunk;
    },
  };
  return adapter;
}

async function openRoom(
  sessionId: string,
  adapter: LlmAdapter,
  store = new Persistence(db),
) {
  const lease = await new SessionLease(db).acquire(sessionId, randomUUID());
  if (!lease) throw new Error('lease unavailable');
  const runner = new ProductionSoloTurnRunner(
    db,
    undefined,
    'record',
    join(dir, `${randomUUID()}.ndjson`),
    adapter,
    false,
    true,
  );
  return new Room(store, lease, await store.loadLatest(sessionId), runner);
}

async function waitForCompletion(sessionId: string) {
  for (let i = 0; i < 200; i++) {
    const { rows } = await db.query(
      "SELECT 1 FROM events WHERE session_id=$1 AND type='NarrationCompleted'",
      [sessionId],
    );
    if (rows.length) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('narration did not complete');
}

beforeAll(async () => {
  db = new Pool({ connectionString: databaseUrl });
  dir = await mkdtemp(join(tmpdir(), 'content-tier-room-'));
});
afterAll(async () => {
  await db.end();
  await rm(dir, { recursive: true, force: true });
});

describe('mature narration through Room and Persistence', () => {
  it('withholds the mature narration from an opted-out seat that joins mid-stream', async () => {
    const owner = await account(false);
    const optedOut = await account(true);
    const sessionId = await session(owner);
    const joiner = recorder();
    const adapter = twoChunkNarrator(async () => {
      await room.join(optedOut, joiner.connection, 'Joiner');
    });
    const room = await openRoom(sessionId, adapter);
    const ownerSeen = recorder();
    await room.join(owner, ownerSeen.connection, 'Owner');

    expect(
      await room.submitAction(owner, randomUUID(), 'We look around.', 'Owner'),
    ).toBe(true);
    await waitForCompletion(sessionId);

    expect(narrationText(ownerSeen.sent)).toBe('The torch gutters.');
    expect(narrationText(joiner.sent)).toBe('');
    expect(joiner.sent.some((m) => m.type === 'NarrationCompleted')).toBe(
      false,
    );
  });

  it('stops the remainder of a mature narration for a seat that opts out mid-stream', async () => {
    const owner = await account(false);
    const sessionId = await session(owner);
    const store = new Persistence(db);
    const realEligible = store.matureEligibleAccounts.bind(store);
    let lookups = 0;
    store.matureEligibleAccounts = async (ids) => {
      lookups += 1;
      if (lookups === 2)
        await db.query('UPDATE accounts SET mature_opt_out=true WHERE id=$1', [
          owner,
        ]);
      return realEligible(ids);
    };
    const room = await openRoom(
      sessionId,
      singleTextNarrator(LONG_NARRATION),
      store,
    );
    const ownerSeen = recorder();
    await room.join(owner, ownerSeen.connection, 'Owner');

    await room.submitAction(owner, randomUUID(), 'We look around.', 'Owner');
    await waitForCompletion(sessionId);

    expect(narrationText(ownerSeen.sent)).toBe(LONG_NARRATION.slice(0, 24));
  });

  it('withholds a mature narration from a seat whose account is being deleted', async () => {
    const owner = await account(false);
    const deleting = await account(false, 'deleting');
    const sessionId = await session(owner);
    const joiner = recorder();
    const adapter = twoChunkNarrator(async () => {
      await room.join(deleting, joiner.connection, 'Deleting');
    });
    const room = await openRoom(sessionId, adapter);
    const ownerSeen = recorder();
    await room.join(owner, ownerSeen.connection, 'Owner');

    await room.submitAction(owner, randomUUID(), 'We look around.', 'Owner');
    await waitForCompletion(sessionId);

    expect(narrationText(joiner.sent)).toBe('');
  });

  it('does not send the last mature narration to an opted-out seat that joins after the turn', async () => {
    const owner = await account(false);
    const optedOut = await account(true);
    const sessionId = await session(owner);
    const room = await openRoom(sessionId, singleTextNarrator(LONG_NARRATION));
    await room.join(owner, recorder().connection, 'Owner');
    await room.submitAction(owner, randomUUID(), 'inspect-the-sconce', 'Owner');
    await waitForCompletion(sessionId);

    const late = recorder();
    await room.join(optedOut, late.connection, 'Late');

    const wire = JSON.stringify(late.sent);
    expect(wire).toContain('StateSync');
    expect(wire).not.toContain('The torch gutters');
    expect(wire).not.toContain('inspect-the-sconce');
  });

  it('does not resend the last mature narration to an opted-out seat that reconnects after the turn', async () => {
    const owner = await account(false);
    const optedOut = await account(true);
    const sessionId = await session(owner);
    const room = await openRoom(sessionId, singleTextNarrator(LONG_NARRATION));
    await room.join(owner, recorder().connection, 'Owner');
    await room.join(optedOut, recorder().connection, 'Opted');
    await room.disconnect(optedOut);
    await room.submitAction(owner, randomUUID(), 'inspect-the-sconce', 'Owner');
    await waitForCompletion(sessionId);

    const reconnect = recorder();
    await room.join(optedOut, reconnect.connection, 'Opted');

    const wire = JSON.stringify(reconnect.sent);
    expect(wire).toContain('StateSync');
    expect(wire).not.toContain('The torch gutters');
    expect(wire).not.toContain('inspect-the-sconce');
  });

  it('runs the round as standard when a deleting seat is already present at round open', async () => {
    const owner = await account(false);
    const deleting = await account(false, 'deleting');
    const sessionId = await session(owner);
    const room = await openRoom(sessionId, singleTextNarrator(LONG_NARRATION));
    const ownerSeen = recorder();
    const deletingSeen = recorder();
    await room.join(owner, ownerSeen.connection, 'Owner');
    await room.join(deleting, deletingSeen.connection, 'Deleting');

    await room.submitAction(owner, randomUUID(), 'We look around.', 'Owner');
    await waitForCompletion(sessionId);

    expect(narrationText(ownerSeen.sent)).toBe(LONG_NARRATION);
    expect(narrationText(deletingSeen.sent)).toBe(LONG_NARRATION);
  });
});
