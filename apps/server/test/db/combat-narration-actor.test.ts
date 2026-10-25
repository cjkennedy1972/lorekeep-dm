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
import { ProductionSoloTurnRunner } from '../../src/room/productionTurnRunner.js';
import { deleteTestSessions } from './testCleanup.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL required');
const ADVENTURE = 'adventure:01-hollow-under-marrowfell';
let db: Pool;
let dir: string;
const accountIds: string[] = [];
const sessionIds: string[] = [];

async function narrationRequest(combatRoom: Record<string, unknown>) {
  const accountId = randomUUID();
  await db.query(
    `INSERT INTO accounts(id,email,password_hash,display_name,status,is_adult,age_checked_at,terms_version,terms_accepted_at) VALUES($1,$2,'hash','Solo','active',true,now(),'v1',now())`,
    [accountId, `${accountId}@example.test`],
  );
  accountIds.push(accountId);
  const sessionId = randomUUID();
  await db.query(
    'INSERT INTO sessions(id,owner_account_id,name,adventure_id) VALUES($1,$2,$3,$4)',
    [sessionId, accountId, 'Narration table', ADVENTURE],
  );
  await db.query(
    `INSERT INTO events(session_id,seq,turn_id,type,payload) VALUES($1,1,$1,'SeatJoined',$2)`,
    [sessionId, JSON.stringify({ accountId, displayName: 'Solo' })],
  );
  sessionIds.push(sessionId);
  const calls: LlmRequest[] = [];
  const adapter: LlmAdapter = {
    capabilities: () => ({
      streaming: true,
      nativeTools: true,
      jsonSchema: true,
    }),
    probe: async () => true,
    async *complete(request: LlmRequest) {
      calls.push(request);
      yield { type: 'text', delta: 'The turn resolves.' } as LlmChunk;
    },
  };
  const runner = new ProductionSoloTurnRunner(
    db,
    undefined,
    'record',
    join(dir, `${sessionId}.ndjson`),
    adapter,
    true,
    false,
    undefined,
    async () => true,
  );
  await runner.run(
    {
      sessionId,
      accountId,
      actionId: randomUUID(),
      text: 'Narrate.',
      state: {
        lastNarration: 'Earlier tale.',
        lastPlayerText: 'Earlier ask.',
        combatRoom,
      },
    },
    () => undefined,
  );
  return JSON.stringify(calls);
}

// Recent turns reach the prompt base64-encoded.
const EARLIER = Buffer.from('Earlier tale.').toString('base64');

const combatRoom = (activeEntityId: string, ended = false) => ({
  ended,
  entities: [
    { id: 'ent_aria', hp: 10, maxHp: 10 },
    { id: 'ent_ambusher_9', hp: 5, maxHp: 5, hidden: true },
  ],
  combat: {
    round: 1,
    resources: {},
    activeEntityId,
    initiative: [{ entityId: 'ent_aria' }, { entityId: 'ent_ambusher_9' }],
  },
});

beforeAll(async () => {
  db = new Pool({ connectionString: databaseUrl });
  dir = await mkdtemp(join(tmpdir(), 'narration-actor-'));
});
afterAll(async () => {
  await deleteTestSessions(db, sessionIds);
  for (const id of accountIds)
    await db.query('DELETE FROM accounts WHERE id=$1', [id]);
  await db.end();
  await rm(dir, { recursive: true, force: true });
});

describe('combat narration request through ProductionSoloTurnRunner', () => {
  it('does not name a hidden next combatant as the active actor', async () => {
    const hidden = await narrationRequest(combatRoom('ent_ambusher_9'));
    expect(hidden).not.toContain('ent_ambusher_9');
    const visible = await narrationRequest(combatRoom('ent_aria'));
    expect(visible).toContain('Active combatant: ent_aria');
  });

  it('keeps prior turns once combat has ended', async () => {
    expect(await narrationRequest(combatRoom('ent_aria'))).not.toContain(
      EARLIER,
    );
    expect(await narrationRequest(combatRoom('ent_aria', true))).toContain(
      EARLIER,
    );
  });
});
