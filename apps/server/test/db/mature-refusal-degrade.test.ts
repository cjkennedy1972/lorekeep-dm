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
import type { Moderator } from '../../src/safety/moderator.js';

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
    `INSERT INTO sessions(id,owner_account_id,name,moderation_verified)
     VALUES($1,$2,$3,true)`,
    [id, owner, 'Refusal degrade'],
  );
  return id;
}

/** Fails every mature-tier request with the given status and answers standard requests with STANDARD_TEXT. */
function matureRefusingNarrator(
  calls: { mature: number; standard: number },
  status: number,
) {
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
        throw new LlmEndpointError('endpoint-error', 'refused', status);
      }
      calls.standard += 1;
      yield { type: 'text', delta: STANDARD_TEXT } as LlmChunk;
    },
  };
  return adapter;
}

const STANDARD_TEXT = 'The torch gutters low over the stone.';
const allowOutput: Moderator = {
  async moderate() {
    return {
      verdict: 'allow',
      category: 'other',
      source: 'judge',
      latencyMs: 0,
      unavailable: false,
    };
  },
};

async function waitForNarrationSent(sent: Sent[], count: number) {
  for (let i = 0; i < 300; i++) {
    if (sent.filter((m) => m.type === 'NarrationCompleted').length >= count)
      return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('narration did not complete');
}

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
    allowOutput,
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
  it.each([400, 401, 403, 429])(
    'fails closed on a %i without demoting the runner or the session tier',
    async (status) => {
      const owner = await account();
      const sessionId = await session(owner);
      const calls = { mature: 0, standard: 0 };
      const room = await openRoom(
        sessionId,
        matureRefusingNarrator(calls, status),
      );
      const seen = recorder();
      await room.join(owner, seen.connection, 'Owner');
      await db.query("UPDATE sessions SET content_tier='mature' WHERE id=$1", [
        sessionId,
      ]);

      await room.submitAction(owner, randomUUID(), 'We look around.', 'Owner');
      await waitForNarrationSent(seen.sent, 1);

      expect(calls).toEqual({ mature: 1, standard: 0 });
      expect(narrationText(seen.sent)).toContain('not resolved');
      const { rows } = await db.query(
        "SELECT 1 FROM events WHERE session_id=$1 AND type='ContentTierChanged'",
        [sessionId],
      );
      expect(rows).toHaveLength(0);

      await room.submitAction(owner, randomUUID(), 'We listen.', 'Owner');
      await waitForNarrationSent(seen.sent, 2);

      expect(calls).toEqual({ mature: 2, standard: 0 });
    },
  );

  it('returns no ContentTierChanged from a failed turn whose tier differs from the stored tier', async () => {
    const owner = await account();
    const sessionId = await session(owner);
    await db.query(
      `INSERT INTO events(session_id,seq,turn_id,type,payload) VALUES($1,1,$1,'SeatJoined',$2)`,
      [
        sessionId,
        {
          seatId: randomUUID(),
          accountId: owner,
          displayName: 'Owner',
          presence: 'offline',
          matureOptOut: false,
        },
      ],
    );
    const calls = { mature: 0, standard: 0 };
    const runner = new ProductionSoloTurnRunner(
      db,
      undefined,
      'record',
      join(dir, `${randomUUID()}.ndjson`),
      matureRefusingNarrator(calls, 403),
      false,
      true,
      allowOutput,
    );
    const result = await runner.run(
      {
        sessionId,
        accountId: owner,
        actionId: randomUUID(),
        text: 'We look around.',
        state: {},
      },
      () => undefined,
    );

    expect(calls).toEqual({ mature: 1, standard: 0 });
    expect(result.fallback).toBe('endpoint-error');
    expect(
      result.events.filter(
        (e) => (e as { type?: string }).type === 'ContentTierChanged',
      ),
    ).toEqual([]);
  });

  it('persists no scene or tier writes from a successful tool round whose next endpoint call fails', async () => {
    const owner = await account();
    const sessionId = await session(owner);
    await db.query(
      "UPDATE sessions SET adventure_id='adventure:01-hollow-under-marrowfell', content_tier='mature' WHERE id=$1",
      [sessionId],
    );
    let requests = 0;
    const adapter: LlmAdapter = {
      capabilities: () => ({
        streaming: true,
        nativeTools: true,
        jsonSchema: true,
      }),
      probe: async () => true,
      async *complete() {
        requests += 1;
        if (requests > 1)
          throw new LlmEndpointError('endpoint-error', 'refused', 500);
        yield {
          type: 'tool-call',
          id: 'c1',
          name: 'close_scene',
          arguments: { summary: 'The seal is opened.' },
        } as LlmChunk;
        yield {
          type: 'tool-call',
          id: 'c2',
          name: 'upsert_npc',
          arguments: {
            id: 'npc_mira',
            name: 'Mira',
            role: 'Guide',
            disposition: 'friendly',
            facts: ['Lives in town'],
          },
        } as LlmChunk;
      },
    };
    const room = await openRoom(sessionId, adapter);
    const seen = recorder();
    await room.join(owner, seen.connection, 'Owner');
    await room.persistGameState({
      sceneId: 'scene-marowfell-well',
      adventureId: 'adventure:01-hollow-under-marrowfell',
    });

    await room.submitAction(owner, randomUUID(), 'We open the seal.', 'Owner');
    await waitForNarrationSent(seen.sent, 1);

    expect(requests).toBe(2);
    const { rows: events } = await db.query(
      "SELECT type FROM events WHERE session_id=$1 AND type IN ('SceneClosed','ContentTierChanged','NpcUpserted')",
      [sessionId],
    );
    expect(events).toHaveLength(0);
  });

  it('emits no ContentTierChanged for a standard turn at standard', async () => {
    const owner = await account();
    const sessionId = await session(owner);
    const calls = { mature: 0, standard: 0 };
    const room = await openRoom(sessionId, matureRefusingNarrator(calls, 403));
    const seen = recorder();
    await room.join(owner, seen.connection, 'Owner');
    await db.query('UPDATE accounts SET mature_opt_out=true WHERE id=$1', [
      owner,
    ]);

    await room.submitAction(owner, randomUUID(), 'We look around.', 'Owner');
    await waitForNarrationSent(seen.sent, 1);

    expect(calls).toEqual({ mature: 0, standard: 1 });
    expect(narrationText(seen.sent)).toBe(STANDARD_TEXT);
    const { rows } = await db.query(
      "SELECT 1 FROM events WHERE session_id=$1 AND type='ContentTierChanged'",
      [sessionId],
    );
    expect(rows).toHaveLength(0);
  });
});
