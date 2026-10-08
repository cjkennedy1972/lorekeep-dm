import { describe, expect, test } from 'vitest';
import { replayCryptCombat, runCryptScenario } from '@game/rules-engine';

// Exercises the real engine scenario (no LLM, no network); the web keyboard run is
// apps/web/e2e/sandbox-combat.spec.ts (Playwright).
describe('M1 exit criterion 2: scripted solo combat', () => {
  const run = runCryptScenario(2901);
  const types = run.events.map((e) => e.type);

  test('log contains OpportunityTriggered and an AreaResolved with >=2 affected', () => {
    expect(types).toContain('OpportunityTriggered');
    const area = run.events.find((e) => e.type === 'AreaResolved');
    expect((area?.affected as string[]).length).toBeGreaterThanOrEqual(2);
  });

  test('ends in CombatEnded: final state and last event', () => {
    expect(run.finalState.outcome).toBe('CombatEnded');
    expect(types.at(-1)).toBe('CombatEnded');
    expect(types.filter((t) => t === 'CombatEnded')).toHaveLength(1);
  });

  test('same seed gives an identical log, replay reproduces final state', () => {
    const again = runCryptScenario(2901);
    expect(JSON.stringify(again)).toBe(JSON.stringify(run));
    expect(replayCryptCombat(run)).toEqual(run.finalState);
  });

  test('a different seed still terminates in CombatEnded (not a literal script)', () => {
    const other = runCryptScenario(7);
    expect(other.seed).toBe(7);
    expect(other.finalState.outcome).toBe('CombatEnded');
  });
});
