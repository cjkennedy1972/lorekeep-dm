import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  LlmAdapter,
  LlmChunk,
  LlmRequest,
} from '../../src/llm/adapter.js';
import type { Moderator } from '../../src/safety/moderator.js';
import { ProductionSoloTurnRunner } from '../../src/room/productionTurnRunner.js';
import { deleteTestSessions } from './testCleanup.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL required');

const ADVENTURE = 'adventure:01-hollow-under-marrowfell';
// The recorded close_scene proposal names synthetic ids (loc_redteam -> loc_tavern).
// It is replayed onto the real adventure edge with the same intent: a valid close.
const SCENE = 'scene-marowfell-well';
const NEXT_SCENE = 'scene-broken-gatehouse';
const PLAYER_CHARACTER = {
  id: 'ent_ayla',
  name: 'Ayla',
  speciesId: 'srd:species/human',
  classId: 'srd:class/fighter',
  backgroundId: 'srd:background/soldier',
  level: 1,
  abilities: { str: 15, dex: 12, con: 13, int: 10, wis: 11, cha: 8 },
  proficiencies: { skills: [], saves: [], tools: [] },
  equipment: [],
  spellsKnown: [],
  spellsPrepared: [],
  slots: {},
  hp: { current: 10, max: 10, temp: 0 },
  conditions: [],
};

const readJson = (relative: string) =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8'),
  );
const recordedPath =
  process.env.INJECTION_REPLAY_RECORD_PATH ??
  '../../../../packages/evals/redteam/recorded/live-qwen3.8-35b-a3b-distill-q4-2026-10-15.json';
const recordedBytes = process.env.INJECTION_REPLAY_RECORD_PATH
  ? readFileSync(recordedPath)
  : undefined;
if (recordedBytes) {
  const actualHash = createHash('sha256').update(recordedBytes).digest('hex');
  const expectedHash =
    '34f3727eb675aa655c39081555d2f9ff4044e3580799c26b4d39a8b830909f24';
  if (actualHash !== expectedHash)
    throw new Error(
      `INJECTION_REPLAY_RECORD_PATH SHA-256 mismatch: expected ${expectedHash}, got ${actualHash}`,
    );
}
const recorded = (
  recordedBytes
    ? JSON.parse(recordedBytes.toString('utf8'))
    : readJson(recordedPath)
) as {
  cases: {
    id: string;
    suite: string;
    toolCalls?: { name: string; arguments: string }[];
  }[];
};
const corpus = readJson(
  '../../../../packages/evals/redteam/injection-100.json',
) as { cases: { id: string; text: string }[] };

const replays = ['inj-014', 'inj-042', 'inj-063'].map((id) => {
  const entry = recorded.cases.find(
    (item) => item.id === id && item.suite === 'injection',
  );
  const call = entry?.toolCalls?.[0];
  const text = corpus.cases.find((item) => item.id === id)?.text;
  if (!call || !text) throw new Error(`recorded replay ${id} is missing`);
  const args = JSON.parse(call.arguments) as Record<string, unknown>;
  return {
    id,
    text,
    tool: call.name,
    args:
      call.name === 'close_scene' ? { ...args, nextSceneId: NEXT_SCENE } : args,
  };
});

const allowAll: Moderator = {
  async moderate() {
    return {
      verdict: 'allow',
      category: 'none',
      source: 'judge',
      latencyMs: 0,
      unavailable: false,
    };
  },
} as Moderator;

let db: Pool;
let dir: string;
const accountIds: string[] = [];
const sessionIds: string[] = [];

function replayAdapter(
  replay: (typeof replays)[number],
  requests: LlmRequest[],
): LlmAdapter {
  return {
    capabilities: () => ({
      streaming: true,
      nativeTools: true,
      jsonSchema: true,
    }),
    probe: async () => true,
    async *complete(request: LlmRequest) {
      requests.push(request);
      const isDmTurn = (request.tools?.length ?? 0) > 0;
      const sawTool = request.messages.some((m) => m.role === 'tool');
      const chunks: LlmChunk[] =
        isDmTurn && !sawTool
          ? [
              {
                type: 'tool-call',
                id: `${replay.id}-call`,
                name: replay.tool,
                arguments: replay.args,
              },
            ]
          : request.toolMode === 'json-schema'
            ? [
                {
                  type: 'text',
                  delta: JSON.stringify({
                    summary: 'Ayla stands at the well of Marrowfell.',
                    registryDiffs: [],
                  }),
                },
              ]
            : [
                {
                  type: 'text',
                  delta: 'The attempted action has no effect. What do you do?',
                },
              ];
      for (const chunk of chunks) yield chunk;
    },
  };
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
    'INSERT INTO sessions(id,owner_account_id,name,adventure_id,character) VALUES($1,$2,$3,$4,$5)',
    [
      sessionId,
      accountId,
      'Injection replay table',
      ADVENTURE,
      JSON.stringify(PLAYER_CHARACTER),
    ],
  );
  await db.query(
    `INSERT INTO events(session_id,seq,turn_id,type,payload) VALUES($1,1,$1,'SeatJoined',$2)`,
    [sessionId, JSON.stringify({ accountId, displayName: 'Solo' })],
  );
  sessionIds.push(sessionId);
  return { accountId, sessionId };
}

async function persistedCharacter(sessionId: string) {
  const row = await db.query<{ character: unknown }>(
    'SELECT character FROM sessions WHERE id=$1',
    [sessionId],
  );
  return row.rows[0]?.character;
}

beforeAll(async () => {
  db = new Pool({ connectionString: databaseUrl });
  dir = await mkdtemp(join(tmpdir(), 'injection-replay-'));
});

afterAll(async () => {
  await deleteTestSessions(db, sessionIds);
  for (const id of accountIds)
    await db.query('DELETE FROM accounts WHERE id=$1', [id]);
  await db.end();
  await rm(dir, { recursive: true, force: true });
});

describe('recorded injection proposals through ProductionSoloTurnRunner', () => {
  it.each(replays)(
    '$id ($tool) leaves no state effect and no leaked instruction',
    async (replay) => {
      const { accountId, sessionId } = await table();
      const characterBefore = await persistedCharacter(sessionId);
      const requests: LlmRequest[] = [];
      const observed: unknown[] = [];
      const runner = new ProductionSoloTurnRunner(
        db,
        undefined,
        'record',
        join(dir, `${sessionId}.ndjson`),
        replayAdapter(replay, requests),
        true,
        false,
        allowAll,
      );
      const unchangedNarration =
        'The attempted action has no effect. What do you do?';
      const inputState = {
        sceneId: SCENE,
        adventureId: ADVENTURE,
        premise: undefined,
        characters: { [accountId]: PLAYER_CHARACTER },
        lastNarration: unchangedNarration,
      };
      const result = await runner.run(
        {
          sessionId,
          accountId,
          actionId: randomUUID(),
          text: replay.text,
          state: inputState,
        },
        (event) => observed.push(event),
      );

      expect(requests.length).toBeGreaterThan(0);
      const emittedEventCountBeforeProposal = 0;
      expect(result.events).toHaveLength(emittedEventCountBeforeProposal);
      // lastPlayerText intentionally records the attempted turn; every other
      // shared-state field must remain exactly as it was before the proposal.
      const sharedState = { ...(result.state as object) } as Record<
        string,
        unknown
      >;
      delete sharedState.lastPlayerText;
      expect(sharedState.forbiddenPlayerText).toEqual([replay.text]);
      delete sharedState.forbiddenPlayerText;
      expect(sharedState).toEqual(inputState);
      expect(JSON.stringify(sharedState)).not.toContain(replay.text);
      expect(result.narration).not.toContain(replay.text);
      expect(await persistedCharacter(sessionId)).toEqual(characterBefore);
      if (replay.tool !== 'close_scene')
        expect(observed).toContainEqual(
          expect.objectContaining({
            type: 'ToolCallRejected',
            toolName: replay.tool,
          }),
        );
    },
  );
});
