import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  LlmAdapter,
  LlmChunk,
  LlmRequest,
} from '../../src/llm/adapter.js';
import { LlmEndpointError } from '../../src/llm/adapter.js';
import { Persistence } from '../../src/persistence/index.js';
import { SessionLease } from '../../src/room/lease.js';
import { Room, type Connection } from '../../src/room/Room.js';
import { ProductionSoloTurnRunner } from '../../src/room/productionTurnRunner.js';
import { MODERATION_SECTIONS } from '../../src/safety/moderationRubric.generated.js';

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

async function account() {
  const id = randomUUID();
  await db.query(
    `INSERT INTO accounts(id,email,password_hash,display_name,status,is_adult,age_checked_at,terms_version,terms_accepted_at,mature_opt_out)
     VALUES($1,$2,'hash','Player','active',true,now(),'v1',now(),false)`,
    [id, `${id}@example.test`],
  );
  return id;
}

async function session(owner: string) {
  const id = randomUUID();
  await db.query(
    'INSERT INTO sessions(id,owner_account_id,name,moderation_verified) VALUES($1,$2,$3,true)',
    [id, owner, 'Refusal degrade'],
  );
  return id;
}

/** Refuses every mature-tier request with a 403 and answers standard requests with STANDARD_TEXT. */
function matureRefusingNarrator(calls: { mature: number; standard: number }) {
  const adapter: LlmAdapter = {
    capabilities: () => ({
      streaming: true,
      nativeTools: true,
      jsonSchema: true,
    }),
    probe: async () => true,
    async *complete(request: LlmRequest) {
      if (
        JSON.stringify(request).includes(MODERATION_SECTIONS['clause:mature'])
      ) {
        calls.mature += 1;
        throw new LlmEndpointError('endpoint-error', 'refused', 403);
      }
      calls.standard += 1;
      yield { type: 'text', delta: STANDARD_TEXT } as LlmChunk;
    },
  };
  return adapter;
}

const STANDARD_TEXT = 'The torch gutters low over the stone.';

async function openRoom(sessionId: string, adapter: LlmAdapter) {
  const store = new Persistence(db);
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

async function waitForCompletions(sessionId: string, count: number) {
  for (let i = 0; i < 300; i++) {
    const { rows } = await db.query(
      "SELECT 1 FROM events WHERE session_id=$1 AND type='NarrationCompleted'",
      [sessionId],
    );
    if (rows.length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('narration did not complete');
}

beforeAll(async () => {
  db = new Pool({ connectionString: databaseUrl });
  dir = await mkdtemp(join(tmpdir(), 'mature-refusal-'));
});
afterAll(async () => {
  await db.end();
  await rm(dir, { recursive: true, force: true });
});

describe('endpoint refusal of a mature prompt', () => {
  it('retries the turn at standard, emits ContentTierChanged, and does not repeat mature on later turns', async () => {
    const owner = await account();
    const sessionId = await session(owner);
    const calls = { mature: 0, standard: 0 };
    const room = await openRoom(sessionId, matureRefusingNarrator(calls));
    const seen = recorder();
    await room.join(owner, seen.connection, 'Owner');

    await room.submitAction(owner, randomUUID(), 'We look around.', 'Owner');
    await waitForCompletions(sessionId, 1);

    expect(calls).toEqual({ mature: 1, standard: 1 });
    expect(narrationText(seen.sent)).toBe(STANDARD_TEXT);
    const { rows } = await db.query(
      "SELECT payload FROM events WHERE session_id=$1 AND type='ContentTierChanged'",
      [sessionId],
    );
    expect(rows.at(-1)?.payload).toMatchObject({ to: 'standard' });

    await room.submitAction(owner, randomUUID(), 'We listen.', 'Owner');
    await waitForCompletions(sessionId, 2);

    expect(calls).toEqual({ mature: 1, standard: 2 });
  });
});
