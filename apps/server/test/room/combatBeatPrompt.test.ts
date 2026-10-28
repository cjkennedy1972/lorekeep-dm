import { afterEach, describe, expect, it } from 'vitest';
import type {
  LlmAdapter,
  LlmChunk,
  LlmRequest,
} from '../../src/llm/adapter.js';
import { ProductionSoloTurnRunner } from '../../src/room/productionTurnRunner.js';

const savedEnv = { ...process.env };
afterEach(() => {
  process.env = { ...savedEnv };
});

describe('combat beat continuity through production prompt assembly', () => {
  it('includes committed beat data in the next live-combat prompt and omits it after combat ends', async () => {
    process.env.NODE_ENV = 'test';
    const prompts: LlmRequest[] = [];
    const adapter: LlmAdapter = {
      capabilities: () => ({
        streaming: true,
        nativeTools: true,
        jsonSchema: true,
      }),
      probe: async () => true,
      async *complete(request) {
        prompts.push(request);
        const chunk: LlmChunk = {
          type: 'text',
          delta: 'The shield rings like a struck bell.',
        };
        yield chunk;
      },
    };
    const db = {
      async query(sql: string) {
        if (sql.includes('FROM sessions s LEFT JOIN catalog_snapshots'))
          return {
            rows: [
              {
                name: 'Table',
                catalog_version: null,
                catalog_snapshot: null,
                premise: null,
                adventure_id: null,
                character: null,
                owner_account_id: 'owner',
              },
            ],
          };
        if (sql.includes('content_tier, moderation_verified'))
          return {
            rows: [
              {
                content_tier: 'standard',
                moderation_verified: false,
                host_tier_cap: null,
                endpoint_allows_mature: false,
              },
            ],
          };
        if (sql.includes('FROM sessions s WHERE s.id=$1'))
          return { rows: [{ '?column?': 1 }] };
        return { rows: [] };
      },
    } as never;
    const runner = new ProductionSoloTurnRunner(
      db,
      undefined,
      undefined,
      undefined,
      adapter,
      false,
    );
    const state = {
      characters: {},
      lastCombatBeat: 'The previous axe stroke split the rain.',
      combatRoom: {
        ended: false,
        combat: { activeEntityId: null, initiative: [], resources: {} },
        entities: [],
      },
    };
    await runner.run(
      {
        sessionId: 'session',
        accountId: 'account',
        actionId: 'action-1',
        text: '[engine narration]',
        state,
        combatNarration: true,
        combatFacts: [
          { type: 'CombatEnded', outcome: 'party-victory', tier: 'must' },
        ],
      },
      () => undefined,
    );
    const prompt = prompts[0]!.messages
      .map((message) => message.content)
      .join('\n');
    expect(prompt).toContain('PREVIOUS COMBAT BEAT');
    expect(prompt).toContain('<<<DM_DATA encoding=base64>>>');
    expect(prompt).toContain(
      Buffer.from(state.lastCombatBeat).toString('base64'),
    );

    await runner.run(
      {
        sessionId: 'session',
        accountId: 'account',
        actionId: 'action-2',
        text: '[exploration]',
        state: { ...state, combatRoom: { ...state.combatRoom, ended: true } },
      },
      () => undefined,
    );
    const afterEnd = prompts[1]!.messages
      .map((message) => message.content)
      .join('\n');
    expect(afterEnd).not.toContain('PREVIOUS COMBAT BEAT');
    expect(afterEnd).not.toContain(
      Buffer.from(state.lastCombatBeat).toString('base64'),
    );
  });
});
