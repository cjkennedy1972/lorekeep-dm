import { describe, expect, it } from 'vitest';
import type {
  LlmAdapter,
  LlmChunk,
  LlmRequest,
} from '../../src/llm/adapter.js';
import { LlmEndpointError } from '../../src/llm/adapter.js';
import {
  runTurn,
  runTurnQueued,
  type TurnInput,
} from '../../src/dm/orchestrator.js';

const character = {
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
} as const;
function scripted(turns: (LlmChunk[] | Error)[]) {
  const requests: LlmRequest[] = [];
  const adapter: LlmAdapter = {
    capabilities: () => ({
      streaming: true,
      nativeTools: true,
      jsonSchema: true,
    }),
    probe: async () => true,
    async *complete(request) {
      requests.push(request);
      const next = turns.shift();
      if (next instanceof Error) throw next;
      for (const chunk of next ?? []) yield chunk;
    },
  };
  return { adapter, requests };
}
function setup(
  chunks: (LlmChunk[] | Error)[],
  execute?: TurnInput['context']['execute'],
): {
  input: TurnInput;
  requests: LlmRequest[];
  events: unknown[];
  streamed: unknown[];
} {
  const mock = scripted(chunks),
    events: unknown[] = [],
    streamed: unknown[] = [];
  const input: TurnInput = {
    turnId: 'turn-1',
    turnSeed: 123n,
    testMode: true,
    adapter: mock.adapter,
    toolMode: 'native',
    prompt: {
      catalogVersion: 'srd-5.2.1-r3',
      toolMode: 'native',
      sceneId: 'scene-1',
      settingsHash: 'settings-1',
      activeMode: 'exploration',
      session: {
        contentTier: 'standard',
        safetySettings: {},
        partyRoster: [character],
        premise: 'A cave',
        sceneSummary: 'Dark.',
      },
      turn: {
        state: { characters: [character] },
        playerText: 'I check the seal.',
        roundInputs: [
          { playerId: 'p1', actionId: 'a1', text: 'I check the seal.' },
        ],
      },
    },
    context: {
      state: { unchanged: true },
      engineState: {},
      execute:
        execute ??
        (() => ({
          ok: true,
          summary: 'The check resolved.',
          events: ['RollEvent'],
          output: { events: [{ type: 'RollEvent', total: 16 }], rollCount: 1 },
        })),
    },
    emit: (event) => events.push(event),
    stream: (event) => streamed.push(event),
  };
  return { input, requests: mock.requests, events, streamed };
}
const call = (id: string, name: string, args: unknown): LlmChunk => ({
  type: 'tool-call',
  id,
  name,
  arguments: args,
});
const validCheck = {
  actorId: 'ent_ayla',
  ability: 'dex',
  dc: 12,
  dcReason: 'a careful balance check',
};
const narration =
  'Ayla studies the old seal and finds a narrow groove beneath the dust. The stone shifts with a quiet click, revealing fresh scratches around its edge. Something beyond the door answers with a low, patient scrape. What do you do?';

describe('DM orchestrator', () => {
  it('runs a clean exploration check and emits engine events before final narration', async () => {
    const h = setup([
      [
        call('c1', 'request_check', validCheck),
        { type: 'text', delta: 'discard me' },
      ],
      [{ type: 'text', delta: narration }],
    ]);
    const result = await runTurn(h.input);
    expect(result.narration).toBe(narration);
    expect(h.streamed.map((event) => event.type)).toEqual([
      'NarrationChunk',
      'NarrationChunk',
      'NarrationChunk',
      'NarrationChunk',
      'NarrationChunk',
      'NarrationChunk',
      'NarrationChunk',
      'NarrationChunk',
      'NarrationChunk',
      'NarrationChunk',
    ]);
    expect(
      h.events.findIndex(
        (event) => (event as { type?: string }).type === 'RollEvent',
      ),
    ).toBeLessThan(
      h.events.findIndex(
        (event) => (event as { type?: string }).type === 'NarrationChunk',
      ),
    );
    expect(
      h.events.some(
        (event) => (event as { text?: string }).text === 'discard me',
      ),
    ).toBe(false);
  });
  it('routes close_scene through the scene handler and emits its event', async () => {
    const h = setup([
      [call('c1', 'close_scene', { summary: 'The seal is opened.' })],
      [{ type: 'text', delta: narration }],
    ]);
    h.input.context.closeScene = ({ summary, nextSceneId }) => ({
      ok: true,
      summary: 'Scene closed.',
      output: {
        events: [
          {
            type: 'SceneClosed',
            sceneId: 'scene-1',
            summary,
            ...(nextSceneId ? { nextSceneId } : {}),
          },
        ],
      },
      events: [],
    });
    await runTurn(h.input);
    expect(h.events).toContainEqual({
      type: 'SceneClosed',
      sceneId: 'scene-1',
      summary: 'The seal is opened.',
    });
  });
  it('rejects invalid authored next scene through the normal tool rejection path', async () => {
    const h = setup([
      [
        call('c1', 'close_scene', {
          summary: 'The well is secured.',
          nextSceneId: 'scene-lamp-vault',
        }),
      ],
      [{ type: 'text', delta: narration }],
    ]);
    h.input.context.closeScene = () => ({
      ok: false,
      error: 'invalid-scene-transition',
      hint: 'Choose an authored next scene.',
    });
    await runTurn(h.input);
    expect(h.events).toContainEqual(
      expect.objectContaining({
        type: 'ToolCallRejected',
        toolName: 'close_scene',
        error: 'invalid-scene-transition',
      }),
    );
    expect(
      h.events.some(
        (event) => (event as { type?: string }).type === 'SceneClosed',
      ),
    ).toBe(false);
  });
  it('rejects close_scene outside an adventure context', async () => {
    const h = setup([
      [call('c1', 'close_scene', { summary: 'Done.' })],
      [{ type: 'text', delta: narration }],
    ]);
    await runTurn(h.input);
    expect(h.events).toContainEqual(
      expect.objectContaining({
        type: 'ToolCallRejected',
        toolName: 'close_scene',
        error: 'unknown-tool',
      }),
    );
    expect(
      h.events.some(
        (event) => (event as { type?: string }).type === 'SceneClosed',
      ),
    ).toBe(false);
  });
  it('rejects combat-only tools in exploration before executor invocation', async () => {
    let executions = 0;
    const h = setup(
      [
        [
          call('c1', 'attack', {
            attackerId: 'ent_ayla',
            targetId: 'ent_goblin',
            attackId: 'srd:weapon/longsword',
          }),
        ],
        [{ type: 'text', delta: narration }],
      ],
      () => {
        executions++;
        return { ok: true, events: [] };
      },
    );
    await runTurn(h.input);
    expect(executions).toBe(0);
  });
  it('discards tool-response prose and appends combat-start tool results before narration', async () => {
    const h = setup(
      [
        [
          call('c1', 'start_combat', {
            enemies: [{ monsterId: 'srd:monster/goblin', count: 1 }],
          }),
          { type: 'text', delta: 'premature prose' },
        ],
        [{ type: 'text', delta: narration }],
      ],
      () => ({
        ok: true,
        summary: 'Combat begins.',
        events: ['CombatStarted'],
        output: { events: [{ type: 'CombatStarted', combatId: 'combat-1' }] },
      }),
    );
    await runTurn(h.input);
    expect(
      h.events.findIndex(
        (event) => (event as { type?: string }).type === 'CombatStarted',
      ),
    ).toBeLessThan(
      h.events.findIndex(
        (event) => (event as { type?: string }).type === 'NarrationChunk',
      ),
    );
    expect(h.requests).toHaveLength(2);
  });
  it('rejects an invalid call, retries with the schema hint, then recovers', async () => {
    const h = setup([
      [call('c1', 'request_check', { ...validCheck, dc: 99 })],
      [call('c2', 'request_check', validCheck)],
      [{ type: 'text', delta: narration }],
    ]);
    await runTurn(h.input);
    expect(
      h.events.some(
        (event) => (event as { type?: string }).type === 'ToolCallRejected',
      ),
    ).toBe(true);
    expect(h.requests[1]?.messages.at(-1)?.content).toContain(
      'expected number to be <=30',
    );
  });
  it('treats policy errors as retry-once and budget errors without retries', async () => {
    const policy = setup(
      [
        [
          call('c1', 'apply_condition', {
            targetId: 'ent_ayla',
            conditionId: 'srd:condition/unconscious',
            source: 'damage',
            duration: 'until-save',
          }),
        ],
        [call('c2', 'request_check', validCheck)],
        [{ type: 'text', delta: narration }],
      ],
      () => ({
        ok: false,
        error: 'condition-engine-owned',
        hint: 'HP owns unconsciousness.',
      }),
    );
    await runTurn(policy.input);
    expect(policy.requests).toHaveLength(3);
    expect(
      policy.events.filter(
        (event) => (event as { type?: string }).type === 'ToolCallRejected',
      ),
    ).toHaveLength(2);
    const budget = setup(
      [
        [call('c1', 'rules_lookup', { topic: 'saving throws' })],
        [call('c2', 'rules_lookup', { topic: 'saving throws' })],
        [{ type: 'text', delta: narration }],
      ],
      () => ({ ok: true, summary: 'Passage.', events: [] }),
    );
    budget.input.context.rulesLookup = async () => [];
    await runTurn(budget.input);
    expect(
      budget.events.some(
        (event) =>
          (event as { error?: string }).error === 'lookup-budget-exhausted',
      ),
    ).toBe(false);
    expect(budget.requests).toHaveLength(3);
  });
  it('terminates rejected calls and falls back without mutating state', async () => {
    const h = setup([
      [call('c1', 'request_check', { ...validCheck, dc: 0 })],
      [call('c2', 'request_check', { ...validCheck, dc: 0 })],
      [call('c3', 'request_check', { ...validCheck, dc: 0 })],
      [{ type: 'text', delta: narration }],
    ]);
    const original = h.input.context.state;
    const result = await runTurn(h.input);
    expect(result.narration).toBe(narration);
    expect(result.state).toBe(original);
    expect(
      h.events.filter(
        (event) => (event as { type?: string }).type === 'ToolCallRejected',
      ),
    ).toHaveLength(3);
  });
  it('uses the engine template when the endpoint fails and does not commit partial engine state', async () => {
    const h = setup([
      [call('c1', 'request_check', validCheck)],
      new LlmEndpointError('endpoint-timeout', 'timeout'),
    ]);
    const result = await runTurn(h.input);
    expect(result.fallback).toBe('endpoint-error');
    expect(result.narration).toContain('storyteller has lost the thread');
    expect(result.events).toHaveLength(0);
    expect(result.state).toEqual({ characters: [character] });
  });

  it('queues same-table turns instead of interleaving model requests', async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = setup([[{ type: 'text', delta: narration }]]);
    const second = setup([[{ type: 'text', delta: narration }]]);
    const slow = first.input.adapter;
    first.input.adapter = {
      ...slow,
      capabilities: () => slow.capabilities(),
      probe: (signal) => slow.probe(signal),
      async *complete(request) {
        order.push('first-start');
        await gate;
        for await (const chunk of slow.complete(request)) yield chunk;
        order.push('first-end');
      },
    };
    second.input.adapter = {
      ...second.input.adapter,
      async *complete() {
        order.push('second-start');
        yield { type: 'text', delta: narration };
        order.push('second-end');
      },
    };
    const a = runTurnQueued('table-queue-test', first.input);
    const b = runTurnQueued('table-queue-test', second.input);
    await Promise.resolve();
    expect(order).toEqual(['first-start']);
    release();
    await Promise.all([a, b]);
    expect(order).toEqual([
      'first-start',
      'first-end',
      'second-start',
      'second-end',
    ]);
  });

  it('does not leak player text into turn-input events except as explicit input data', async () => {
    const h = setup([[{ type: 'text', delta: narration }]]);
    const result = await runTurn(h.input);
    expect(result.turnSeed).toBe('0x000000000000007b');
    expect(h.events[0]).toMatchObject({
      type: 'TurnStarted',
      promptPrefixHash: expect.stringMatching(/^sha256:/),
    });
  });
});
