import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LlmAdapter, LlmChunk } from '../../src/llm/adapter.js';
import { ProductionSoloTurnRunner } from '../../src/room/productionTurnRunner.js';
import { createCombatRuntime } from '../../src/room/combat.js';
import type { RoomCombatState } from '../../src/room/combatTypes.js';
import { deleteTestSessions } from './testCleanup.js';
import { bootstrapped, hero } from '../room/combatFixtures.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL required');

const accountIds: string[] = [];
const sessionIds: string[] = [];
let db: Pool;
let dir: string;

const caster = {
  ...hero,
  spellsKnown: [
    'spell:expeditious-retreat',
    'spell:mage-armor',
    'spell:true-strike',
  ],
  spellsPrepared: [
    'spell:expeditious-retreat',
    'spell:mage-armor',
    'spell:true-strike',
  ],
};

const calls = {
  bonus: {
    name: 'cast_spell',
    args: {
      casterId: 'ent_aria',
      spellId: 'srd:spell/expeditious-retreat',
      slotLevel: 1,
      target: { kind: 'self' },
    },
  },
  action: {
    name: 'cast_spell',
    args: {
      casterId: 'ent_aria',
      spellId: 'srd:spell/mage-armor',
      slotLevel: 1,
      target: { kind: 'self' },
    },
  },
  cantrip: {
    name: 'cast_spell',
    args: {
      casterId: 'ent_aria',
      spellId: 'srd:spell/true-strike',
      slotLevel: 0,
      target: { kind: 'self' },
    },
  },
};

function scriptedCalls(sequence: (typeof calls)[keyof typeof calls][]) {
  const adapter: LlmAdapter = {
    capabilities: () => ({
      streaming: true,
      nativeTools: true,
      jsonSchema: true,
    }),
    probe: async () => true,
    async *complete(request) {
      const toolResponses = request.messages.filter(
        (message) => message.role === 'tool',
      ).length;
      const chunk: LlmChunk | undefined = sequence[toolResponses]
        ? {
            type: 'tool-call',
            id: `spell-call-${toolResponses}`,
            name: sequence[toolResponses]!.name,
            arguments: sequence[toolResponses]!.args,
          }
        : { type: 'text', delta: 'The spell resolves.' };
      if (chunk) yield chunk;
    },
  };
  return adapter;
}

async function setupTable() {
  const accountId = randomUUID();
  await db.query(
    `INSERT INTO accounts(id,email,password_hash,display_name,status,is_adult,age_checked_at,terms_version,terms_accepted_at) VALUES($1,$2,'hash','Aria','active',true,now(),'v1',now())`,
    [accountId, `${accountId}@example.test`],
  );
  accountIds.push(accountId);
  const sessionId = randomUUID();
  await db.query(
    'INSERT INTO sessions(id,owner_account_id,name,character) VALUES($1,$2,$3,$4)',
    [sessionId, accountId, 'Combat spell pairing', JSON.stringify(caster)],
  );
  await db.query(
    `INSERT INTO events(session_id,seq,turn_id,type,payload) VALUES($1,1,$1,'SeatJoined',$2)`,
    [sessionId, JSON.stringify({ accountId, displayName: 'Aria' })],
  );
  sessionIds.push(sessionId);
  const boot = bootstrapped();
  const gameState = {
    ...boot.game,
    gameEngine: { ...boot.game.gameEngine, actors: { ent_aria: caster } },
    characters: { [accountId]: caster },
    combatActors: { [accountId]: 'ent_aria' },
    combatRoom: boot.state,
  };
  return { accountId, sessionId, gameState, combat: boot.state };
}

async function runScripted(
  table: Awaited<ReturnType<typeof setupTable>>,
  state: Record<string, unknown>,
  sequence: (typeof calls)[keyof typeof calls][],
) {
  const runner = new ProductionSoloTurnRunner(
    db,
    undefined,
    'record',
    join(dir, `${randomUUID()}.ndjson`),
    scriptedCalls(sequence),
    true,
    false,
  );
  const observed: unknown[] = [];
  const result = await runner.run(
    {
      sessionId: table.sessionId,
      accountId: table.accountId,
      actionId: randomUUID(),
      text: 'Cast the requested spells.',
      state,
    },
    (event) => observed.push(event),
  );
  return { result, observed };
}

beforeAll(async () => {
  db = new Pool({ connectionString: databaseUrl });
  dir = await mkdtemp(join(tmpdir(), 'combat-spell-pairing-'));
});

afterAll(async () => {
  await deleteTestSessions(db, sessionIds);
  for (const id of accountIds)
    await db.query('DELETE FROM accounts WHERE id=$1', [id]);
  await db.end();
  await rm(dir, { recursive: true, force: true });
});

describe('bonus-action spell pairing across combat paths', () => {
  it('rejects a scripted bonus spell after a command action spell', async () => {
    const table = await setupTable();
    const runtime = createCombatRuntime();
    const commandAction = runtime.execute(
      table.combat,
      'ent_aria',
      {
        command: 'cast',
        spellId: 'spell:mage-armor',
        slotLevel: 1,
        target: { kind: 'self' },
      },
      { character: caster },
    );
    if ('code' in commandAction) throw new Error(commandAction.message);
    expect(commandAction.state.combat.resources.ent_aria?.action).toBe(false);

    const scripted = await runScripted(
      table,
      { ...table.gameState, combatRoom: commandAction.state },
      [calls.bonus],
    );
    expect(scripted.observed).toContainEqual(
      expect.objectContaining({
        type: 'ToolCallRejected',
        toolName: 'cast_spell',
        error: 'forbidden',
      }),
    );
  });

  it('rejects a command bonus spell after a scripted action spell', async () => {
    const table = await setupTable();
    const scripted = await runScripted(table, table.gameState, [calls.action]);
    const combat = (scripted.result.state as { combatRoom: RoomCombatState })
      .combatRoom;
    expect(combat.combat.resources.ent_aria?.action).toBe(false);
    const command = createCombatRuntime().execute(
      combat,
      'ent_aria',
      {
        command: 'cast',
        spellId: 'spell:expeditious-retreat',
        slotLevel: 1,
        target: { kind: 'self' },
      },
      { character: caster },
    );
    expect(command).toMatchObject({ code: 'COMMAND_REJECTED' });
  });

  it('shares a command bonus-spell flag with scripted action spells and allows a cantrip', async () => {
    const table = await setupTable();
    const runtime = createCombatRuntime();
    const commandBonus = runtime.execute(
      table.combat,
      'ent_aria',
      {
        command: 'cast',
        spellId: 'spell:expeditious-retreat',
        slotLevel: 1,
        target: { kind: 'self' },
      },
      { character: caster },
    );
    if ('code' in commandBonus) throw new Error(commandBonus.message);
    expect(commandBonus.state.combat.resources.ent_aria?.bonusAction).toBe(
      false,
    );

    const seeded = {
      ...table.gameState,
      combatRoom: commandBonus.state,
    };
    const action = await runScripted(table, seeded, [calls.action]);
    expect(action.observed).toContainEqual(
      expect.objectContaining({
        type: 'ToolCallRejected',
        toolName: 'cast_spell',
        error: 'forbidden',
      }),
    );

    const cantrip = runtime.execute(
      commandBonus.state,
      'ent_aria',
      {
        command: 'cast',
        spellId: 'spell:true-strike',
        slotLevel: 0,
        target: { kind: 'self' },
      },
      { character: caster },
    );
    expect(cantrip).not.toMatchObject({ code: 'COMMAND_REJECTED' });
  });

  it('shares a scripted bonus-spell flag with commands and allows an action cantrip', async () => {
    const table = await setupTable();
    const scripted = await runScripted(table, table.gameState, [calls.bonus]);
    const combat = (scripted.result.state as { combatRoom: RoomCombatState })
      .combatRoom;
    expect(combat.combat.resources.ent_aria?.bonusActionSpellCast).toBe(true);
    expect(combat.combat.resources.ent_aria?.bonusAction).toBe(false);
    expect(combat.combat.resources.ent_aria?.action).toBe(true);

    const runtime = createCombatRuntime();
    expect(
      runtime.execute(
        combat,
        'ent_aria',
        {
          command: 'cast',
          spellId: 'spell:expeditious-retreat',
          slotLevel: 1,
          target: { kind: 'self' },
        },
        { character: caster },
      ),
    ).toMatchObject({ code: 'COMMAND_REJECTED' });
    expect(
      runtime.execute(
        combat,
        'ent_aria',
        {
          command: 'cast',
          spellId: 'spell:mage-armor',
          slotLevel: 1,
          target: { kind: 'self' },
        },
        { character: caster },
      ),
    ).toMatchObject({ code: 'COMMAND_REJECTED' });
    const cantrip = runtime.execute(
      combat,
      'ent_aria',
      {
        command: 'cast',
        spellId: 'spell:true-strike',
        slotLevel: 0,
        target: { kind: 'self' },
      },
      { character: caster },
    );
    expect(cantrip).not.toMatchObject({ code: 'COMMAND_REJECTED' });
    if (!('code' in cantrip))
      expect(cantrip.state.combat.resources.ent_aria?.action).toBe(false);
  });

  it('rejects a scripted cantrip after a command spell spends the shared action', async () => {
    const table = await setupTable();
    const command = createCombatRuntime().execute(
      table.combat,
      'ent_aria',
      {
        command: 'cast',
        spellId: 'spell:mage-armor',
        slotLevel: 1,
        target: { kind: 'self' },
      },
      { character: caster },
    );
    if ('code' in command) throw new Error(command.message);

    expect(command.state.combat.resources.ent_aria?.action).toBe(false);
    const scripted = await runScripted(
      table,
      { ...table.gameState, combatRoom: command.state },
      [calls.cantrip],
    );
    expect(scripted.observed).toContainEqual(
      expect.objectContaining({
        type: 'ToolCallRejected',
        toolName: 'cast_spell',
        error: 'forbidden',
      }),
    );
  });

  it('rejects a command cantrip after a scripted spell spends the shared action', async () => {
    const table = await setupTable();
    const scripted = await runScripted(table, table.gameState, [calls.action]);
    const combat = (scripted.result.state as { combatRoom: RoomCombatState })
      .combatRoom;

    expect(combat.combat.resources.ent_aria?.action).toBe(false);
    expect(
      createCombatRuntime().execute(
        combat,
        'ent_aria',
        {
          command: 'cast',
          spellId: 'spell:true-strike',
          slotLevel: 0,
          target: { kind: 'self' },
        },
        { character: caster },
      ),
    ).toMatchObject({ code: 'COMMAND_REJECTED' });
  });

  it('spends action for a scripted action cantrip', async () => {
    const table = await setupTable();
    const scripted = await runScripted(table, table.gameState, [calls.cantrip]);
    const combat = (scripted.result.state as { combatRoom: RoomCombatState })
      .combatRoom;

    expect(scripted.observed).not.toContainEqual(
      expect.objectContaining({ type: 'ToolCallRejected' }),
    );
    expect(combat.combat.resources.ent_aria?.action).toBe(false);
  });

  it('keeps the shared tracker across multiple cast_spell calls in one runner turn', async () => {
    const table = await setupTable();
    const { observed } = await runScripted(table, table.gameState, [
      calls.bonus,
      calls.action,
    ]);
    expect(observed).toContainEqual(
      expect.objectContaining({
        type: 'ToolCallRejected',
        toolName: 'cast_spell',
        error: 'forbidden',
      }),
    );
  });

  it('cannot spend the same action twice across scripted calls in one runner turn', async () => {
    const table = await setupTable();
    const scripted = await runScripted(table, table.gameState, [
      calls.cantrip,
      calls.cantrip,
    ]);
    const combat = (scripted.result.state as { combatRoom: RoomCombatState })
      .combatRoom;

    expect(scripted.observed).toContainEqual(
      expect.objectContaining({
        type: 'ToolCallRejected',
        toolName: 'cast_spell',
        error: 'forbidden',
      }),
    );
    expect(combat.combat.resources.ent_aria?.action).toBe(false);
  });
});
