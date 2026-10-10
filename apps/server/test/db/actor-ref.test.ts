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

/** Scripted DM that asks for a check on the player's character, referenced by its UUID id as a real model would. */
function checkingDm(actorId: string, toolResults: string[]): LlmAdapter {
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
                id: 'call_check',
                name: 'request_check',
                arguments: {
                  actorId,
                  ability: 'wis',
                  skill: 'srd:skill/perception',
                  dc: 12,
                  dcReason: 'Searching the stonework for an inscription',
                },
              },
            ]
          : [{ type: 'text', delta: 'You trace the stone with your fingers.' }];
      for (const chunk of chunks) yield chunk;
    },
  };
}

beforeAll(async () => {
  db = new Pool({ connectionString: databaseUrl });
  dir = await mkdtemp(join(tmpdir(), 'actor-ref-'));
});
afterAll(async () => {
  for (const id of sessionIds)
    await db.query('DELETE FROM sessions WHERE id=$1', [id]);
  for (const id of accountIds)
    await db.query('DELETE FROM accounts WHERE id=$1', [id]);
  await db.end();
  await rm(dir, { recursive: true, force: true });
});

describe('actor tools accept the real player character id', () => {
  it('request_check with the character UUID resolves instead of failing schema validation', async () => {
    const catalog = loadCatalog();
    const character = {
      ...quickBuild(catalog, 'class:cleric', 0x28, 1).character,
      id: randomUUID(),
    };
    const accountId = randomUUID();
    await db.query(
      `INSERT INTO accounts(id,email,password_hash,display_name,status,is_adult,age_checked_at,terms_version,terms_accepted_at) VALUES($1,$2,'hash','Actor','active',true,now(),'v1',now())`,
      [accountId, `${accountId}@example.test`],
    );
    accountIds.push(accountId);
    await db.query(
      `INSERT INTO catalog_snapshots(catalog_version,entries) VALUES($1,$2::jsonb) ON CONFLICT (catalog_version) DO NOTHING`,
      [catalog.catalogVersion, JSON.stringify(catalog.entries)],
    );
    const sessionId = randomUUID();
    await db.query(
      `INSERT INTO sessions(id,owner_account_id,name,status,mode,adventure_id,difficulty,catalog_version,character_id,character)
       VALUES($1,$2,'Actor ref','active','solo',$3,'moderate',$4,$5,$6::jsonb)`,
      [
        sessionId,
        accountId,
        ADVENTURE,
        catalog.catalogVersion,
        character.id,
        JSON.stringify(character),
      ],
    );
    sessionIds.push(sessionId);
    const toolResults: string[] = [];
    const seen: { type?: string; reason?: string; error?: string }[] = [];
    const runner = new ProductionSoloTurnRunner(
      db,
      undefined,
      'record',
      join(dir, 'f.ndjson'),
      checkingDm(character.id, toolResults),
    );
    const result = await runner.run(
      {
        sessionId,
        accountId,
        actionId: randomUUID(),
        text: 'I search the stonework for a hidden inscription.',
        state: { sceneId: 'scene-marowfell-well', adventureId: ADVENTURE },
      },
      (e) => seen.push(e as never),
    );
    const types = seen.map((e) => e.type);
    expect(types, JSON.stringify(seen)).not.toContain('ToolCallRejected');
    expect(types).not.toContain('TurnFallback');
    expect(result.narration).toContain('trace the stone');
    expect(toolResults.length).toBeGreaterThan(0);
    expect(JSON.parse(toolResults[0]!)).toMatchObject({ ok: true });
  });
});
