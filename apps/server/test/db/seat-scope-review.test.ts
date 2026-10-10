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

/** Scripted DM that makes one tool call on the first model step, then narrates. */
function toolCallingDm(
  call: { name: string; args: Record<string, unknown> },
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
          ? [
              {
                type: 'tool-call',
                id: 'call_seat',
                name: call.name,
                arguments: call.args,
              },
            ]
          : [{ type: 'text', delta: 'The scene moves on.' }];
      for (const chunk of chunks) yield chunk;
    },
  };
}

beforeAll(async () => {
  db = new Pool({ connectionString: databaseUrl });
  dir = await mkdtemp(join(tmpdir(), 'seat-scope-'));
});
afterAll(async () => {
  for (const id of sessionIds)
    await db.query('DELETE FROM sessions WHERE id=$1', [id]);
  for (const id of accountIds)
    await db.query('DELETE FROM accounts WHERE id=$1', [id]);
  await db.end();
  await rm(dir, { recursive: true, force: true });
});

async function insertAccount(id: string) {
  await db.query(
    `INSERT INTO accounts(id,email,password_hash,display_name,status,is_adult,age_checked_at,terms_version,terms_accepted_at) VALUES($1,$2,'hash','Seat','active',true,now(),'v1',now())`,
    [id, `${id}@example.test`],
  );
  accountIds.push(id);
}

async function insertSession(
  accountId: string,
  character: Record<string, unknown> | null,
) {
  const catalog = loadCatalog();
  await db.query(
    `INSERT INTO catalog_snapshots(catalog_version,entries) VALUES($1,$2::jsonb) ON CONFLICT (catalog_version) DO NOTHING`,
    [catalog.catalogVersion, JSON.stringify(catalog.entries)],
  );
  const sessionId = randomUUID();
  await db.query(
    `INSERT INTO sessions(id,owner_account_id,name,status,mode,adventure_id,difficulty,catalog_version,character_id,character)
     VALUES($1,$2,'Seat scope','active','solo',$3,'moderate',$4,$5,$6::jsonb)`,
    [
      sessionId,
      accountId,
      ADVENTURE,
      catalog.catalogVersion,
      (character?.id as string | undefined) ?? null,
      JSON.stringify(character),
    ],
  );
  sessionIds.push(sessionId);
  return sessionId;
}

function newCharacter(seed: number) {
  return {
    ...quickBuild(loadCatalog(), 'class:cleric', seed, 1).character,
    id: randomUUID(),
  };
}

describe('model tool calls stay on the submitting seat', () => {
  it('rejects a check naming an unknown character when the table has no characters', async () => {
    const accountId = randomUUID();
    await insertAccount(accountId);
    const sessionId = await insertSession(accountId, null);
    const toolResults: string[] = [];
    const runner = new ProductionSoloTurnRunner(
      db,
      undefined,
      'record',
      join(dir, 'zero-characters.ndjson'),
      toolCallingDm(
        {
          name: 'request_check',
          args: {
            actorId: randomUUID(),
            ability: 'wis',
            skill: 'srd:skill/perception',
            dc: 12,
            dcReason: 'Searching the stonework for an inscription',
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
        text: 'I look around the well.',
        state: { sceneId: 'scene-marowfell-well', adventureId: ADVENTURE },
      },
      () => undefined,
    );
    expect(toolResults.length).toBeGreaterThan(0);
    expect(JSON.parse(toolResults[0]!)).toMatchObject({
      ok: false,
      error: 'unknown-entity',
    });
  });

  it('rejects a world-registry tool argument that names another seat character', async () => {
    const accountId = randomUUID();
    const otherAccountId = randomUUID();
    await insertAccount(accountId);
    await insertAccount(otherAccountId);
    const own = newCharacter(0x40);
    const other = newCharacter(0x41);
    const sessionId = await insertSession(accountId, own);
    const toolResults: string[] = [];
    const runner = new ProductionSoloTurnRunner(
      db,
      undefined,
      'record',
      join(dir, 'world-tool.ndjson'),
      toolCallingDm(
        {
          name: 'log_ruling',
          args: { topic: 'Seat scope', ruling: `Ruling about ${other.id}` },
        },
        toolResults,
      ),
    );
    await runner.run(
      {
        sessionId,
        accountId,
        actionId: randomUUID(),
        text: 'I ask for a ruling on my companion.',
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
    });
  });
});
