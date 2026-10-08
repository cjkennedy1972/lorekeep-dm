import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  replayCryptCombat,
  runCryptScenario,
} from '../src/scripted/scenario-crypt.js';

const goldenPath = fileURLToPath(
  new URL('./golden/scripted-combat.json', import.meta.url),
);

describe('scripted crypt solo combat', () => {
  test('fixed-seed run satisfies encounter acceptance and matches the golden event log', () => {
    const run = runCryptScenario(2901);
    expect(run.finalState.outcome).toBe('CombatEnded');
    expect(run.events.map((event) => event.type)).toContain(
      'OpportunityTriggered',
    );
    expect(run.events.map((event) => event.type)).toContain('ReactionResolved');
    const area = run.events.find((event) => event.type === 'AreaResolved');
    expect(area?.affected).toEqual(
      expect.arrayContaining(['goblin-1', 'goblin-2']),
    );
    expect(area?.affected).not.toContain('pc-aria');
    expect(
      run.finalState.entities
        .filter((entity) => entity.team === 'goblin')
        .every((entity) => entity.hp === 0),
    ).toBe(true);
    if (process.env.UPDATE_GOLDEN === '1')
      writeFileSync(goldenPath, `${JSON.stringify(run, null, 2)}\n`);
    expect(`${JSON.stringify(run, null, 2)}\n`).toBe(
      readFileSync(goldenPath, 'utf8'),
    );
  });

  test('re-running with the same seed is byte-identical and replay reproduces final state', () => {
    const first = runCryptScenario(2901);
    const second = runCryptScenario(2901);
    expect(JSON.stringify(first.events)).toBe(JSON.stringify(second.events));
    expect(replayCryptCombat(first)).toEqual(first.finalState);
  });

  test('scripted modules have no network or LLM imports', () => {
    const sources = [
      '../src/scripted/policy.ts',
      '../src/scripted/scenario-crypt.ts',
    ]
      .map((relative) =>
        readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8'),
      )
      .join('\n');
    expect(sources).not.toMatch(
      /from\s+['"][^'"]*(?:https?:|fetch|llm|openai|anthropic)[^'"]*['"]/i,
    );
    expect(sources).not.toMatch(/\bfetch\s*\(/i);
  });
});
