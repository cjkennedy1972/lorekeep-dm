import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LlmAdapter } from '../../src/llm/adapter.js';
import { ProductionSoloTurnRunner } from '../../src/room/productionTurnRunner.js';
import type { RoomCombatState } from '../../src/room/combatTypes.js';
import { deleteTestSessions } from './testCleanup.js';
import { bootstrapped, hero, placed } from '../room/combatFixtures.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL required');

const accountIds: string[] = [];
const sessionIds: string[] = [];
let db: Pool;
let dir: string;

type Call = { name: string; args: unknown };
/** A call is either fixed or built from the previous tool results the model has seen. */
type Step = Call | ((seenTools: string[]) => Call);

function scripted(steps: Step[], seen: string[][]) {
  const adapter: LlmAdapter = {
    capabilities: () => ({
      streaming: true,
      nativeTools: true,
      jsonSchema: true,
    }),
    probe: async () => true,
    async *complete(request) {
      const tools = request.messages
        .filter((m) => m.role === 'tool')
        .map((m) => JSON.stringify(m.content));
      seen.push(tools);
      const step = steps[tools.length];
      if (!step) {
        yield { type: 'text', delta: 'Done.' };
        return;
      }
      const call = typeof step === 'function' ? step(tools) : step;
      yield {
        type: 'tool-call',
        id: `call-${tools.length}`,
        name: call.name,
        arguments: call.args,
      };
    },
  };
  return adapter;
}

const suggest: Call = {
  name: 'suggest_area_target',
  args: {
    spellId: 'srd:spell/burning-hands',
    casterId: 'ent_aria',
    intent: 'max-enemies',
  },
};
const castVia = (ref: string): Call => ({
  name: 'cast_spell',
  args: {
    casterId: 'ent_aria',
    spellId: 'srd:spell/burning-hands',
    slotLevel: 1,
    target: { kind: 'option', ref },
  },
});
const healingWord: Call = {
  name: 'cast_spell',
  args: {
    casterId: 'ent_aria',
    spellId: 'srd:spell/healing-word',
    slotLevel: 1,
    target: { kind: 'entity', ref: 'ent_aria' },
  },
};
const handleIn = (tools: string[]) =>
  /opt_[a-z0-9]{4,8}/.exec(tools.join(' '))?.[0] ?? 'opt_missing';

/** Aria's turn with a goblin in reach of burning hands (ahead of her, east). */
function ariaTurn(): RoomCombatState {
  return placed(bootstrapped().state, {
    ent_aria: { x: 7, y: 2 },
    'ent_goblin-minion_1': { x: 8, y: 2 },
    'ent_goblin-minion_2': { x: 13, y: 16 },
  });
}

async function setup(combat: RoomCombatState) {
  const accountId = randomUUID();
  await db.query(
    `INSERT INTO accounts(id,email,password_hash,display_name,status,is_adult,age_checked_at,terms_version,terms_accepted_at) VALUES($1,$2,'hash','Aria','active',true,now(),'v1',now())`,
    [accountId, `${accountId}@example.test`],
  );
  accountIds.push(accountId);
  const sessionId = randomUUID();
  await db.query(
    'INSERT INTO sessions(id,owner_account_id,name,character) VALUES($1,$2,$3,$4)',
    [sessionId, accountId, 'Map tools runner', JSON.stringify(hero)],
  );
  await db.query(
    `INSERT INTO events(session_id,seq,turn_id,type,payload) VALUES($1,1,$1,'SeatJoined',$2)`,
    [
      sessionId,
      JSON.stringify({
        seatId: randomUUID(),
        accountId,
        displayName: 'Aria',
        presence: 'connected',
      }),
    ],
  );
  sessionIds.push(sessionId);
  const boot = bootstrapped();
  const state = {
    ...boot.game,
    gameEngine: { ...boot.game.gameEngine, actors: { ent_aria: hero } },
    characters: { [accountId]: hero },
    combatActors: { [accountId]: 'ent_aria' },
    combatRoom: combat,
  };
  return { accountId, sessionId, state };
}

async function run(
  table: Awaited<ReturnType<typeof setup>>,
  state: Record<string, unknown>,
  steps: Step[],
) {
  const seen: string[][] = [];
  const runner = new ProductionSoloTurnRunner(
    db,
    undefined,
    'record',
    join(dir, `${randomUUID()}.ndjson`),
    scripted(steps, seen),
    true,
    false,
  );
  const observed: { type?: string; error?: string }[] = [];
  const result = await runner.run(
    {
      sessionId: table.sessionId,
      accountId: table.accountId,
      actionId: randomUUID(),
      text: 'Aim and cast.',
      state,
    },
    (event) => observed.push(event as never),
  );
  return {
    observed,
    seen,
    room: (result.state as { combatRoom: RoomCombatState }).combatRoom,
  };
}

beforeAll(async () => {
  db = new Pool({ connectionString: databaseUrl });
  dir = await mkdtemp(join(tmpdir(), 'combat-map-tools-'));
});

afterAll(async () => {
  await deleteTestSessions(db, sessionIds);
  for (const id of accountIds)
    await db.query('DELETE FROM accounts WHERE id=$1', [id]);
  await db.end();
  await rm(dir, { recursive: true, force: true });
});

describe('combat narration tools through the production runner', () => {
  it('rejects move_to without changing position or movement', async () => {
    const table = await setup(ariaTurn());
    const before = ariaTurn();
    const out = await run(table, table.state, [
      {
        name: 'move_to',
        args: {
          entityId: 'ent_aria',
          targetRef: 'mk_entrance',
          mode: 'within',
        },
      },
    ]);
    expect(out.observed).toContainEqual(
      expect.objectContaining({
        type: 'ToolCallRejected',
        toolName: 'move_to',
        error: 'unknown-tool',
      }),
    );
    const beforeAria = before.entities.find((e) => e.id === 'ent_aria')!;
    const afterAria = out.room.entities.find((e) => e.id === 'ent_aria')!;
    expect(afterAria.pos).toEqual(beforeAria.pos);
    expect(out.room.combat.resources.ent_aria!.movementRemaining).toBe(
      before.combat.resources.ent_aria!.movementRemaining,
    );
  });

  it('allows area suggestions but rejects a cast without spending combat resources', async () => {
    const table = await setup(ariaTurn());
    const initial = ariaTurn();
    const out = await run(table, table.state, [
      suggest,
      (tools) => castVia(handleIn(tools)),
    ]);
    expect(out.seen[1]!.join(' ')).toMatch(/opt_[a-z0-9]{4,8}/);
    expect(out.observed).toContainEqual(
      expect.objectContaining({
        type: 'ToolCallRejected',
        toolName: 'cast_spell',
        error: 'unknown-tool',
      }),
    );
    expect(out.room.combat.resources.ent_aria!.action).toBe(true);
    expect(out.room.combat.resources.ent_aria!.actionSpellCast).toBe(false);
    expect(out.room.combat.resources.ent_aria!.movementRemaining).toBe(
      initial.combat.resources.ent_aria!.movementRemaining,
    );
  });

  it('rejects a bonus-action spell call without spending the bonus action', async () => {
    const table = await setup(ariaTurn());
    const out = await run(table, table.state, [healingWord]);
    expect(out.observed).toContainEqual(
      expect.objectContaining({
        type: 'ToolCallRejected',
        toolName: 'cast_spell',
        error: 'unknown-tool',
      }),
    );
    expect(out.room.combat.resources.ent_aria!.bonusAction).toBe(true);
    expect(out.room.optionHandles).toBeUndefined();
  });

  it('rejects stale cast handles at the read-only combat boundary', async () => {
    const room = {
      ...ariaTurn(),
      optionHandles: {
        opt_stale1: {
          pos: { x: 8, y: 2 },
          expiresTurn: 'an-earlier-turn',
          affected: ['ent_goblin-minion_1'],
        },
      },
    };
    const table = await setup(room);
    const out = await run(table, { ...table.state, combatRoom: room }, [
      castVia('opt_stale1'),
    ]);
    expect(out.observed).toContainEqual(
      expect.objectContaining({
        type: 'ToolCallRejected',
        toolName: 'cast_spell',
        error: 'unknown-tool',
      }),
    );
    expect(out.room.combat.resources.ent_aria!.action).toBe(true);
  });
});
