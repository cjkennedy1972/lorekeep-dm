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
import type { Moderator } from '../../src/safety/moderator.js';
import { ProductionSoloTurnRunner } from '../../src/room/productionTurnRunner.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL required');
const ADVENTURE = 'adventure:01-hollow-under-marrowfell';
let db: Pool;
let dir: string;
const accountIds: string[] = [];
const sessionIds: string[] = [];

/** Scripted DM: calls close_scene once per args entry and returns a scene summary. */
function closingDm(
  args: Record<string, unknown> | Record<string, unknown>[],
  calls: LlmRequest[],
  generatedSummary = 'The party moves on.',
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
          : request.toolMode === 'json-schema'
            ? [
                {
                  type: 'text',
                  delta: JSON.stringify({
                    summary: generatedSummary,
                    registryDiffs: [],
                  }),
                },
              ]
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
  moderator?: Moderator,
  generatedSummary?: string,
) {
  const { accountId, sessionId } = await table();
  const calls: LlmRequest[] = [];
  const seen: unknown[] = [];
  const runner = new ProductionSoloTurnRunner(
    db,
    undefined,
    'record',
    join(dir, `${sessionId}.ndjson`),
    closingDm(args, calls, generatedSummary),
    true,
    false,
    moderator,
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
  return { result, closed, calls, sessionId };
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
  it('rejects unsafe registry prose before it enters world state or the event result', async () => {
    const { accountId, sessionId } = await table();
    const calls: LlmRequest[] = [];
    const adapter: LlmAdapter = {
      capabilities: () => ({
        streaming: true,
        nativeTools: true,
        jsonSchema: true,
      }),
      probe: async () => true,
      async *complete(request) {
        calls.push(request);
        if (request.messages.some((message) => message.role === 'tool')) {
          yield { type: 'text', delta: 'The adventure continues.' };
          return;
        }
        yield {
          type: 'tool-call',
          id: 'upsert-unsafe-npc',
          name: 'upsert_npc',
          arguments: {
            id: 'npc_bad',
            name: 'Unsafe NPC',
            role: 'villain',
            disposition: 'hostile',
            facts: ['Graphic gore description.'],
          },
        };
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
      {
        async moderate() {
          return {
            verdict: 'block',
            category: 'violence',
            source: 'judge',
            latencyMs: 1,
            unavailable: false,
          };
        },
      },
    );

    const result = await runner.run(
      {
        sessionId,
        accountId,
        actionId: randomUUID(),
        text: 'Continue.',
        state: { sceneId: 'scene-marowfell-well', adventureId: ADVENTURE },
      },
      () => undefined,
    );
    const world = (result.state as { world?: { npcs?: object } }).world;
    const stored = await db.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM registry_entries WHERE session_id=$1',
      [sessionId],
    );

    expect(calls).toHaveLength(2);
    expect(result.events).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'NpcUpserted' }),
      ]),
    );
    expect(world?.npcs).toEqual({});
    expect(stored.rows[0]?.count).toBe(0);
  });

  it('does not emit a blocked model-authored SceneClosed summary', async () => {
    const { result, closed } = await turn(
      'scene-marowfell-well',
      {
        summary: 'Unsafe gore summary.',
      },
      {
        async moderate() {
          return {
            verdict: 'block',
            category: 'violence',
            source: 'judge',
            latencyMs: 1,
            unavailable: false,
          };
        },
      },
    );

    expect(closed).toHaveLength(0);
    expect(result.events).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'SceneClosed' }),
      ]),
    );
  });

  it('persists only the authored fallback when the generated scene summary is blocked', async () => {
    const unsafeGeneratedSummary = 'Unsafe gore summary from the summarizer.';
    const moderationTexts: string[] = [];
    const { result, sessionId } = await turn(
      'scene-marowfell-well',
      { summary: 'The party leaves the well.' },
      {
        async moderate(request) {
          moderationTexts.push(request.text);
          return {
            verdict:
              request.text === unsafeGeneratedSummary ? 'block' : 'allow',
            category:
              request.text === unsafeGeneratedSummary ? 'violence' : 'none',
            source: 'judge',
            latencyMs: 1,
            unavailable: false,
          };
        },
      },
      unsafeGeneratedSummary,
    );
    const stored = await db.query<{ summary: string }>(
      'SELECT summary FROM scene_summaries WHERE session_id=$1',
      [sessionId],
    );

    expect(moderationTexts).toContain('The party leaves the well.');
    expect(moderationTexts).toContain(unsafeGeneratedSummary);
    expect(
      moderationTexts.filter((text) => text === unsafeGeneratedSummary),
    ).toHaveLength(1);
    expect(JSON.stringify(result.events)).not.toContain(unsafeGeneratedSummary);
    expect(stored.rows[0]?.summary).toBe('The scene has ended.');
    expect(stored.rows[0]?.summary).not.toContain(unsafeGeneratedSummary);
  });

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
