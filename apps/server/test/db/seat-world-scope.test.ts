import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { quickBuild } from '@game/rules-engine';
import { loadCatalog } from '@game/rules-engine/catalog-node';
import type {
  LlmAdapter,
  LlmChunk,
  LlmRequest,
} from '../../src/llm/adapter.js';
import { ProductionSoloTurnRunner } from '../../src/room/productionTurnRunner.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL required');
const ADVENTURE = 'adventure:01-hollow-under-marrowfell';
let db: Pool;
let dir: string;
const accountIds: string[] = [];
const sessionIds: string[] = [];

function scriptedDm(
  call: { name: string; arguments: Record<string, unknown> },
  toolResults: string[],
): LlmAdapter {
  return {
    capabilities: () => ({
      streaming: true,
      nativeTools: true,
      jsonSchema: true,
    }),
    probe: async () => true,
    async *complete(request: LlmRequest) {
      const sawTool = request.messages.some((m) => m.role === 'tool');
      for (const m of request.messages)
        if (m.role === 'tool') toolResults.push(m.content);
      const chunks: LlmChunk[] =
        (request.tools?.length ?? 0) > 0 && !sawTool
          ? [{ type: 'tool-call', id: 'call_world', ...call }]
          : [{ type: 'text', delta: 'The ledger is updated.' }];
      for (const chunk of chunks) yield chunk;
    },
  };
}

beforeAll(async () => {
  db = new Pool({ connectionString: databaseUrl });
  dir = await mkdtemp(join(tmpdir(), 'seat-world-'));
});
afterAll(async () => {
  for (const id of sessionIds)
    await db.query('DELETE FROM sessions WHERE id=$1', [id]);
  for (const id of accountIds)
    await db.query('DELETE FROM accounts WHERE id=$1', [id]);
  await db.end();
  await rm(dir, { recursive: true, force: true });
});

async function seedTwoSeats() {
  const catalog = loadCatalog();
  const own = {
    ...quickBuild(catalog, 'class:cleric', 0x28, 1).character,
    id: randomUUID(),
  };
  const other = {
    ...quickBuild(catalog, 'class:cleric', 0x29, 2).character,
    id: randomUUID(),
  };
  const accountId = randomUUID();
  const otherAccountId = randomUUID();
  for (const id of [accountId, otherAccountId]) {
    await db.query(
      `INSERT INTO accounts(id,email,password_hash,display_name,status,is_adult,age_checked_at,terms_version,terms_accepted_at) VALUES($1,$2,'hash','Seat','active',true,now(),'v1',now())`,
      [id, `${id}@example.test`],
    );
    accountIds.push(id);
  }
  await db.query(
    `INSERT INTO catalog_snapshots(catalog_version,entries) VALUES($1,$2::jsonb) ON CONFLICT (catalog_version) DO NOTHING`,
    [catalog.catalogVersion, JSON.stringify(catalog.entries)],
  );
  const sessionId = randomUUID();
  await db.query(
    `INSERT INTO sessions(id,owner_account_id,name,status,mode,adventure_id,difficulty,catalog_version,character_id,character)
     VALUES($1,$2,'World scope','active','solo',$3,'moderate',$4,$5,$6::jsonb)`,
    [
      sessionId,
      accountId,
      ADVENTURE,
      catalog.catalogVersion,
      own.id,
      JSON.stringify(own),
    ],
  );
  sessionIds.push(sessionId);
  return { accountId, otherAccountId, own, other, sessionId };
}

describe('world-registry tools stay on the submitting seat', () => {
  it('rejects a log_ruling that names another seat character', async () => {
    const { accountId, otherAccountId, own, other, sessionId } =
      await seedTwoSeats();
    const toolResults: string[] = [];
    const runner = new ProductionSoloTurnRunner(
      db,
      undefined,
      'record',
      join(dir, 'world.ndjson'),
      scriptedDm(
        {
          name: 'log_ruling',
          arguments: {
            topic: 'Companion conduct',
            ruling: `Character ${other.id} is bound by this ruling.`,
          },
        },
        toolResults,
      ),
    );
    await runner.run(
      {
        sessionId,
        accountId,
        actionId: randomUUID(),
        text: 'I rule on my companion.',
        state: {
          sceneId: 'scene-marowfell-well',
          adventureId: ADVENTURE,
          characters: { [accountId]: own, [otherAccountId]: other },
        },
      },
      () => undefined,
    );
    expect(toolResults.length).toBeGreaterThan(0);
    expect(JSON.parse(toolResults[0]!)).toMatchObject({
      ok: false,
      error: 'unknown-entity',
      hint: 'Only your own character can be named in this action.',
    });
  });
});
