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
import type { SoloTurnRunner } from '../../src/room/dmTurn.js';
import { Room, type RoomStore } from '../../src/room/Room.js';
import { ProductionSoloTurnRunner } from '../../src/room/productionTurnRunner.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL required');
const ADVENTURE = 'adventure:01-hollow-under-marrowfell';
const SCENE = 'scene-marowfell-well';
const NEXT_SCENE = 'scene-broken-gatehouse';
let db: Pool;
let dir: string;
const accountIds: string[] = [];
const sessionIds: string[] = [];

/** The DM closes the scene once; the tool-less summary request is held until `release`. */
function slowSummaryDm() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const summaryStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const adapter: LlmAdapter = {
    capabilities: () => ({
      streaming: true,
      nativeTools: true,
      jsonSchema: true,
    }),
    probe: async () => true,
    async *complete(request: LlmRequest) {
      const isDmTurn = (request.tools?.length ?? 0) > 0;
      const sawTool = request.messages.some((m) => m.role === 'tool');
      if (isDmTurn && !sawTool) {
        yield {
          type: 'tool-call',
          id: 'call_close',
          name: 'close_scene',
          arguments: { summary: 'The party leaves the well.' },
        } as LlmChunk;
        return;
      }
      if (!isDmTurn) {
        started();
        await gate;
      }
      yield { type: 'text', delta: 'The party leaves the well.' };
    },
  };
  return { adapter, release, summaryStarted };
}

async function seedTable() {
  const accountId = randomUUID();
  await db.query(
    `INSERT INTO accounts(id,email,password_hash,display_name,status,is_adult,age_checked_at,terms_version,terms_accepted_at) VALUES($1,$2,'hash','Solo','active',true,now(),'v1',now())`,
    [accountId, `${accountId}@example.test`],
  );
  accountIds.push(accountId);
  const sessionId = randomUUID();
  await db.query(
    'INSERT INTO sessions(id,owner_account_id,name,adventure_id) VALUES($1,$2,$3,$4)',
    [sessionId, accountId, 'Drain scene close', ADVENTURE],
  );
  sessionIds.push(sessionId);
  return { accountId, sessionId };
}

async function harness(
  sessionId: string,
  dm: ReturnType<typeof slowSummaryDm>,
) {
  const inner = new ProductionSoloTurnRunner(
    db,
    undefined,
    undefined,
    undefined,
    dm.adapter,
  );
  let turnDone: Promise<unknown> = Promise.resolve();
  const runner: SoloTurnRunner = {
    run(request, emit) {
      const running = inner.run(request, emit);
      turnDone = running.catch(() => undefined);
      return running;
    },
  };
  const writes: { gameState: { sceneId: string } }[] = [];
  let leaseHeld = true;
  const store: RoomStore = {
    async loadLatest() {
      return { snapshot: null, events: [] };
    },
    async writeTurn(_id, inputs, state) {
      if (!leaseHeld) throw new Error('lease lost');
      writes.push(state as never);
      return {
        events: inputs.map((input, index) => ({
          ...input,
          seq: index + 1,
          sessionId,
          ts: new Date(),
        })),
      } as never;
    },
  };
  const room = new Room(
    store,
    {
      sessionId,
      nodeId: 'node',
      epoch: 1,
      expiresAt: new Date(Date.now() + 60_000),
    },
    { snapshot: null, events: [] },
    runner,
  );
  await room.persistGameState({ sceneId: SCENE, adventureId: ADVENTURE });
  writes.length = 0;
  return {
    room,
    writes,
    turnDone: () => turnDone,
    releaseLease: () => {
      leaseHeld = false;
    },
  };
}

async function closedRows(sessionId: string) {
  const { rowCount } = await db.query(
    'SELECT 1 FROM scene_summaries WHERE session_id=$1 AND scene_id=$2',
    [sessionId, SCENE],
  );
  return rowCount;
}

beforeAll(async () => {
  db = new Pool({ connectionString: databaseUrl });
  dir = await mkdtemp(join(tmpdir(), 'drain-scene-close-'));
});
afterAll(async () => {
  for (const id of sessionIds)
    await db.query('DELETE FROM sessions WHERE id=$1', [id]);
  for (const id of accountIds)
    await db.query('DELETE FROM accounts WHERE id=$1', [id]);
  await db.end();
  await rm(dir, { recursive: true, force: true });
});

describe('scene close against the Room commit', () => {
  it('keeps the DB scene open when drain gives up while the scene is closing', async () => {
    const { accountId, sessionId } = await seedTable();
    const dm = slowSummaryDm();
    const { room, writes, turnDone, releaseLease } = await harness(
      sessionId,
      dm,
    );
    await room.join(accountId, { send() {} });
    expect(
      await room.submitAction(accountId, randomUUID(), 'We finish here.'),
    ).toBe(true);
    await dm.summaryStarted;
    await room.drain(20);
    releaseLease();
    dm.release();
    await turnDone();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(writes.every((state) => state.gameState.sceneId === SCENE)).toBe(
      true,
    );
    expect(await closedRows(sessionId)).toBe(0);
  });

  it('closes the scene in the DB and the Room together when the turn commits in time', async () => {
    const { accountId, sessionId } = await seedTable();
    const dm = slowSummaryDm();
    const { room, writes, turnDone } = await harness(sessionId, dm);
    await room.join(accountId, { send() {} });
    expect(
      await room.submitAction(accountId, randomUUID(), 'We finish here.'),
    ).toBe(true);
    await dm.summaryStarted;
    dm.release();
    await turnDone();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await closedRows(sessionId)).toBe(1);
    expect(writes.at(-1)?.gameState.sceneId).toBe(NEXT_SCENE);
  });
});
