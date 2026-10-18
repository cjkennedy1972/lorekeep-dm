import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LlmAdapter, LlmRequest } from '../../src/llm/adapter.js';
import type { Moderator } from '../../src/safety/moderator.js';
import { X_CARD_REDIRECT_TEMPLATE } from '../../src/safety/outputGate.js';
import { runTurn, type TurnInput } from '../../src/dm/orchestrator.js';

interface XCardCase {
  id: string;
  tier: 'family' | 'standard' | 'mature';
  expected: string;
  effect: string;
  context: string;
}

const dataset = JSON.parse(
  readFileSync(
    new URL(
      '../../../../packages/evals/redteam/xcard-redirect.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as { cases: XCardCase[] };

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

const redirectRows = dataset.cases.filter((c) => c.expected === 'redirected');

function replay(row: XCardCase) {
  const requests: LlmRequest[] = [];
  const executed: string[] = [];
  const moderated: string[] = [];
  const adapter: LlmAdapter = {
    capabilities: () => ({ streaming: true, nativeTools: true, jsonSchema: true }),
    probe: async () => true,
    async *complete(request) {
      requests.push(request);
      yield { type: 'text', delta: 'MODEL OUTPUT MUST NOT APPEAR' };
    },
  };
  const moderator: Moderator = {
    async moderate(req) {
      moderated.push(req.text);
      return {
        verdict: 'allow',
        category: 'none',
        source: 'judge',
        latencyMs: 0,
        unavailable: false,
      };
    },
  };
  const input: TurnInput = {
    turnId: `replay-${row.id}`,
    turnSeed: 1n,
    testMode: true,
    adapter,
    toolMode: 'native',
    outputModerator: moderator,
    outputTier: row.tier === 'family' ? 'family' : row.tier,
    prompt: {
      catalogVersion: 'srd-5.2.1-r3',
      toolMode: 'native',
      sceneId: 'scene-1',
      settingsHash: 'settings-1',
      activeMode: 'exploration',
      session: {
        contentTier: row.tier,
        safetySettings: {},
        partyRoster: [character],
        premise: 'A cave',
        sceneSummary: 'Dark.',
        steerAway: true,
      },
      turn: {
        state: { characters: [character] },
        playerText: 'I keep going.',
        roundInputs: [
          { playerId: 'p1', actionId: 'a1', text: 'I keep going.' },
        ],
      },
    } as TurnInput['prompt'],
    context: {
      state: { unchanged: true },
      engineState: {},
      execute: (call) => {
        executed.push(String(call));
        return { ok: true, summary: '', events: [], output: {} } as never;
      },
    },
  };
  return { input, requests, executed, moderated };
}

describe('X-card steer bypass replay (M3-28, no live model)', () => {
  it('dataset has the 16 redirect rows the bypass must cover', () => {
    expect(redirectRows).toHaveLength(16);
  });

  it.each(redirectRows.map((row) => [row.id, row] as const))(
    '%s redirects with authored narration, no model call, no tool, no state change',
    async (_id, row) => {
      const { input, requests, executed, moderated } = replay(row);
      const result = await runTurn(input);

      expect(result.narration).toBe(X_CARD_REDIRECT_TEMPLATE);
      expect(requests).toHaveLength(0);
      expect(executed).toHaveLength(0);
      expect(result.state).toEqual({ unchanged: true });
      expect(moderated.join('')).toBe(X_CARD_REDIRECT_TEMPLATE);
      expect(result.fallback).toBeUndefined();
    },
  );
});
