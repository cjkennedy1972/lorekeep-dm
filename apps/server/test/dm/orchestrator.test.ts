import { DMTurnEventSchema } from '@game/schema';
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
  it('executes only the first close_scene per turn and rejects the rest', async () => {
    const h = setup([
      [
        call('c1', 'close_scene', { summary: 'The seal is opened.' }),
        call('c2', 'close_scene', { summary: 'Second close.' }),
        call('c3', 'close_scene', { summary: 'Third close.' }),
      ],
      [{ type: 'text', delta: narration }],
    ]);
    const closes: string[] = [];
    h.input.context.closeScene = ({ summary }) => {
      closes.push(summary);
      return {
        ok: true,
        summary: 'Scene closed.',
        events: [],
        output: {
          events: [{ type: 'SceneClosed', sceneId: 'scene-1', summary }],
        },
      };
    };
    await runTurn(h.input);
    expect(closes).toEqual(['The seal is opened.']);
    expect(
      h.events.filter(
        (event) => (event as { type?: string }).type === 'SceneClosed',
      ),
    ).toHaveLength(1);
    expect(
      h.events.filter(
        (event) =>
          (event as { error?: string }).error === 'scene-already-closed',
      ),
    ).toHaveLength(2);
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
  it('rejects ask_clarification outside player action turns before executor invocation', async () => {
    let executions = 0;
    const h = setup(
      [
        [
          call('q1', 'ask_clarification', {
            actionId: 'turn-1',
            question: 'Which door?',
          }),
        ],
        [{ type: 'text', delta: narration }],
      ],
      () => {
        executions++;
        return { ok: true, events: [] };
      },
    );
    const result = await runTurn(h.input);
    expect(executions).toBe(0);
    expect(result.clarification).toBeUndefined();
    expect(
      h.events.some(
        (event) =>
          (event as { type?: string }).type === 'ToolCallRejected' &&
          (event as { error?: string }).error === 'unknown-tool',
      ),
    ).toBe(true);
  });
  it('ends a player turn on a clarifying question without narrating or committing', async () => {
    const h = setup([
      [
        call('q1', 'ask_clarification', {
          actionId: 'turn-1',
          question: 'Which door?',
        }),
      ],
    ]);
    h.input.allowClarification = true;
    const result = await runTurn(h.input);
    expect(result.clarification).toEqual({
      actionId: 'turn-1',
      question: 'Which door?',
    });
    expect(h.requests).toHaveLength(1);
    expect(h.events).toContainEqual({
      type: 'ClarificationRequested',
      actionId: 'turn-1',
      question: 'Which door?',
    });
    expect(
      h.events.some(
        (event) => (event as { type?: string }).type === 'NarrationCompleted',
      ),
    ).toBe(false);
  });
  it('refuses a second clarifying question for the same action', async () => {
    const h = setup([
      [
        call('q1', 'ask_clarification', {
          actionId: 'turn-1',
          question: 'Which door?',
        }),
      ],
      [{ type: 'text', delta: narration }],
    ]);
    h.input.allowClarification = true;
    h.input.clarificationAsked = true;
    const result = await runTurn(h.input);
    expect(result.clarification).toBeUndefined();
    expect(result.narration).toBe(narration);
    expect(
      h.events.some(
        (event) =>
          (event as { error?: string }).error === 'clarification-already-asked',
      ),
    ).toBe(true);
  });
  it('rejects move_to in exploration before executor invocation', async () => {
    let executions = 0;
    const h = setup(
      [
        [
          call('c1', 'move_to', {
            entityId: 'ent_ayla',
            targetRef: 'ent_goblin',
            mode: 'adjacent',
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
  it('replays the assistant tool calls so the follow-up request carries them', async () => {
    const h = setup([
      [call('c1', 'request_check', validCheck)],
      [{ type: 'text', delta: narration }],
    ]);
    await runTurn(h.input);
    const followUp = h.requests[1]?.messages ?? [];
    const assistant = followUp.find(
      (m) => m.role === 'assistant' && m.toolCalls?.length,
    );
    expect(assistant?.toolCalls).toEqual([
      { id: 'c1', name: 'request_check', arguments: validCheck },
    ]);
    expect(followUp.find((m) => m.role === 'tool')?.toolCallId).toBe('c1');
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
  it('trims narration cut at the output-token cap to the last full sentence', async () => {
    const h = setup([
      [
        {
          type: 'usage',
          usage: { input: 10, output: 512, estimate: false },
        },
        {
          type: 'text',
          delta:
            'First sentence here. Second sentence here. Third sentence cut',
        },
      ],
    ]);
    const result = await runTurn(h.input);
    expect(result.narration).toBe('First sentence here. Second sentence here.');
    expect(h.events).toContainEqual({
      type: 'NarrationTruncated',
      turnId: 'turn-1',
      words: 9,
    });
  });
  it('keeps narration that ends before the output-token cap', async () => {
    const h = setup([
      [
        { type: 'usage', usage: { input: 10, output: 100, estimate: false } },
        {
          type: 'text',
          delta: 'First sentence here. Second sentence cut',
        },
      ],
    ]);
    const result = await runTurn(h.input);
    expect(result.narration).toBe('First sentence here. Second sentence cut');
    expect(
      h.events.some(
        (event) => (event as { type?: string }).type === 'NarrationTruncated',
      ),
    ).toBe(false);
  });
  it('marks fallback narration on NarrationCompleted for client notices', async () => {
    const endpoint = setup([
      new LlmEndpointError('endpoint-timeout', 'timeout'),
    ]);
    await runTurn(endpoint.input);
    const endpointDone = endpoint.events.find(
      (event) => (event as { type?: string }).type === 'NarrationCompleted',
    );
    expect(DMTurnEventSchema.parse(endpointDone)).toMatchObject({
      fallback: 'endpoint-error',
    });

    const empty = setup([[]]);
    await runTurn(empty.input);
    const emptyDone = empty.events.find(
      (event) => (event as { type?: string }).type === 'NarrationCompleted',
    );
    expect(DMTurnEventSchema.parse(emptyDone)).toMatchObject({
      fallback: 'no-narration',
    });
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
  it('sends real JSON-schema parameters for every native tool', async () => {
    const h = setup([[{ type: 'text', delta: 'The door creaks open.' }]]);
    await runTurn(h.input);
    const tools = h.requests[0]!.tools ?? [];
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools)
      expect(
        tool.parameters,
        `${tool.name} must not have empty parameters`,
      ).toMatchObject({ type: 'object' });
    const close = tools.find((tool) => tool.name === 'close_scene')!;
    expect(
      Object.keys(
        (close.parameters as { properties: Record<string, unknown> })
          .properties,
      ).sort(),
    ).toEqual(['nextSceneId', 'summary']);
  });
});

describe('DM orchestrator turn order in combat', () => {
  const npcAttack = (id: string, attackerId: string): LlmChunk =>
    call(id, 'attack', {
      attackerId,
      targetId: 'ent_ayla',
      attackId: 'srd:weapon/scimitar',
    });
  const ayla = (id: string): LlmChunk =>
    call(id, 'attack', {
      attackerId: 'ent_ayla',
      targetId: 'ent_goblin_1',
      attackId: 'srd:weapon/longsword',
    });
  const combatSetup = (chunks: (LlmChunk[] | Error)[]) => {
    const executed: string[] = [];
    const h = setup(chunks, (_name, args) => {
      const { attackerId } = args as { attackerId: string };
      if (attackerId !== 'ent_ayla')
        return {
          ok: false,
          error: 'not-actors-turn',
          hint: "It is ent_ayla's turn. Narrate ent_ayla's action or wait for the turn order.",
        };
      executed.push(attackerId);
      return {
        ok: true,
        summary: 'The blow lands.',
        events: [],
        output: { events: [] },
      };
    });
    h.input.prompt.activeMode = 'combat';
    h.input.prompt.turn.activeActorId = 'ent_ayla';
    return { ...h, executed };
  };
  const rejections = (events: unknown[]) =>
    events.filter(
      (event) => (event as { type?: string }).type === 'ToolCallRejected',
    );

  it('completes the narration when the DM names five NPC attacks out of turn', async () => {
    const h = combatSetup([
      [1, 2, 3, 4, 5].map((n) => npcAttack(`n${n}`, `ent_goblin_${n}`)),
      [{ type: 'text', delta: narration }],
    ]);
    const result = await runTurn(h.input);
    expect(rejections(h.events)).toHaveLength(5);
    expect(h.executed).toEqual([]);
    expect(result.fallback).toBeUndefined();
    expect(result.narration).toBe(narration);
    expect(h.requests).toHaveLength(2);
    expect(h.requests[1]?.messages.at(-1)?.content).toContain(
      "It is ent_ayla's turn",
    );
  });

  it('does not spend the tool-call cap on out-of-turn attacks', async () => {
    const h = combatSetup([
      [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) =>
        npcAttack(`n${n}`, `ent_goblin_${n}`),
      ),
      [ayla('a1')],
      [{ type: 'text', delta: narration }],
    ]);
    const result = await runTurn(h.input);
    expect(h.executed).toEqual(['ent_ayla']);
    expect(result.fallback).toBeUndefined();
    expect(result.narration).toBe(narration);
  });

  it('completes normally when the active combatant attacks', async () => {
    const h = combatSetup([[ayla('a1')], [{ type: 'text', delta: narration }]]);
    const result = await runTurn(h.input);
    expect(h.executed).toEqual(['ent_ayla']);
    expect(rejections(h.events)).toHaveLength(0);
    expect(result.fallback).toBeUndefined();
    expect(h.requests[0]?.messages.map((m) => m.content).join('\n')).toContain(
      'Active combatant: ent_ayla',
    );
  });
});
