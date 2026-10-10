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

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL required');
const ADVENTURE = 'adventure:01-hollow-under-marrowfell';
let db: Pool;
let dir: string;
const accountIds: string[] = [];
const sessionIds: string[] = [];

/** Scripted DM: calls close_scene once per args entry; summary requests (no tools) get plain text. */
function closingDm(
  args: Record<string, unknown> | Record<string, unknown>[],
  calls: LlmRequest[],
) {
  const batch = Array.isArray(args) ? args : [args];
  const adapter: LlmAdapter = {
    capabilities: () => ({
      streaming: true,
      nativeTools: true,
      jsonSchema: true,
    }),
    probe: async () => true,
    async *complete(request: LlmRequest) {
      calls.push(request);
      const isDmTurn = (request.tools?.length ?? 0) > 0;
      const sawTool = request.messages.some((m) => m.role === 'tool');
      const chunks: LlmChunk[] =
        isDmTurn && !sawTool
          ? batch.map((closeArgs, index) => ({
              type: 'tool-call',
              id: `call_close_${index}`,
              name: 'close_scene',
              arguments: closeArgs,
            }))
          : [{ type: 'text', delta: 'The party moves on.' }];
      for (const chunk of chunks) yield chunk;
    },
  };
  return adapter;
}

async function table() {
  const accountId = randomUUID();
  await db.query(
    `INSERT INTO accounts(id,email,password_hash,display_name,status,is_adult,age_checked_at,terms_version,terms_accepted_at) VALUES($1,$2,'hash','Solo','active',true,now(),'v1',now())`,
    [accountId, `${accountId}@example.test`],
  );
  accountIds.push(accountId);
  const sessionId = randomUUID();
  await db.query(
    'INSERT INTO sessions(id,owner_account_id,name,adventure_id) VALUES($1,$2,$3,$4)',
    [sessionId, accountId, 'Close scene table', ADVENTURE],
  );
  sessionIds.push(sessionId);
  return { accountId, sessionId };
}

async function turn(
  sceneId: string,
  args: Record<string, unknown> | Record<string, unknown>[],
) {
  const { accountId, sessionId } = await table();
  const calls: LlmRequest[] = [];
  const seen: unknown[] = [];
  const runner = new ProductionSoloTurnRunner(
    db,
    undefined,
    'record',
    join(dir, `${sessionId}.ndjson`),
    closingDm(args, calls),
  );
  const result = await runner.run(
    {
      sessionId,
      accountId,
      actionId: randomUUID(),
      text: 'We finish here and move on.',
      state: { sceneId, adventureId: ADVENTURE },
    },
    (e) => seen.push(e),
  );
  if (process.env.DEBUG_EVENTS)
    console.log(JSON.stringify(seen, null, 1), calls.length);
  const closed = result.events.filter(
    (e) => (e as { type?: string }).type === 'SceneClosed',
  );
  return { result, closed, calls };
}

beforeAll(async () => {
  db = new Pool({ connectionString: databaseUrl });
  dir = await mkdtemp(join(tmpdir(), 'close-scene-'));
});
afterAll(async () => {
  for (const id of sessionIds)
    await db.query('DELETE FROM sessions WHERE id=$1', [id]);
  for (const id of accountIds)
    await db.query('DELETE FROM accounts WHERE id=$1', [id]);
  await db.end();
  await rm(dir, { recursive: true, force: true });
});

describe('close_scene through ProductionSoloTurnRunner', () => {
  it('advances to the authored next scene with exactly one SceneClosed and one summary call', async () => {
    const { result, closed, calls } = await turn('scene-marowfell-well', {
      summary: 'The party leaves the well.',
    });
    expect(closed).toHaveLength(1);
    expect(closed[0]).toMatchObject({ nextSceneId: 'scene-broken-gatehouse' });
    expect(result.state).toMatchObject({ sceneId: 'scene-broken-gatehouse' });
    expect(calls.filter((c) => !(c.tools?.length ?? 0))).toHaveLength(1);
  });

  it('closes once and summarizes once when one response calls close_scene repeatedly', async () => {
    const { result, closed, calls } = await turn('scene-marowfell-well', [
      { summary: 'The party leaves the well.' },
      {
        summary: 'Skipping ahead.',
        nextSceneId: 'scene-broken-gatehouse',
      },
      { summary: 'And again.' },
    ]);
    expect(closed).toHaveLength(1);
    expect(closed[0]).toMatchObject({
      summary: 'The party leaves the well.',
      nextSceneId: 'scene-broken-gatehouse',
    });
    expect(result.state).toMatchObject({ sceneId: 'scene-broken-gatehouse' });
    expect(calls.filter((c) => !(c.tools?.length ?? 0))).toHaveLength(1);
  });

  it('honors a valid requested next scene', async () => {
    const { result } = await turn('scene-marowfell-well', {
      summary: 'Onward.',
      nextSceneId: 'scene-broken-gatehouse',
    });
    expect(result.state).toMatchObject({ sceneId: 'scene-broken-gatehouse' });
  });

  it('rejects an invalid nextSceneId: no event, scene unchanged', async () => {
    const { result, closed } = await turn('scene-marowfell-well', {
      summary: 'Skip ahead.',
      nextSceneId: 'scene-boss-hall',
    });
    expect(closed).toHaveLength(0);
    expect((result.state as { sceneId?: string }).sceneId).toBe(
      'scene-marowfell-well',
    );
  });

  it('marks the adventure completed when a terminal scene closes', async () => {
    const adventure = (
      await import('../../../../packages/engine/adventures/01/adventure.json', {
        with: { type: 'json' },
      })
    ).default as { scenes: { id: string; nextSceneIds?: string[] }[] };
    const terminal = adventure.scenes.find(
      (s) => (s.nextSceneIds ?? []).length === 0,
    )!;
    const { result, closed } = await turn(terminal.id, {
      summary: 'The end.',
    });
    expect(closed).toHaveLength(1);
    expect(result.state).toMatchObject({ adventureCompleted: true });
  });
});
