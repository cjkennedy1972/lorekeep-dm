import { describe, expect, it } from 'vitest';
import {
  shouldRetryCombatStart,
  structuredCombatRetryNudge,
} from '../../src/dm/combatRetry.js';

describe('structured combat retry control', () => {
  const base = {
    hasEligibleEncounter: true,
    hasEligibleNextScene: false,
    startToolAttempted: false,
    sceneClosed: false,
    alreadyRetried: false,
    outputRefused: false,
  };

  it('retries an eligible encounter once, but not after a start attempt or scene close', () => {
    expect(shouldRetryCombatStart(base)).toBe(true);
    expect(shouldRetryCombatStart({ ...base, startToolAttempted: true })).toBe(
      false,
    );
    expect(shouldRetryCombatStart({ ...base, alreadyRetried: true })).toBe(
      false,
    );
    expect(shouldRetryCombatStart({ ...base, outputRefused: true })).toBe(
      false,
    );
    expect(shouldRetryCombatStart({ ...base, sceneClosed: true })).toBe(false);
    expect(
      shouldRetryCombatStart({ ...base, hasEligibleEncounter: false }),
    ).toBe(false);
  });

  it('also retries eligible scene progression when no encounter is offered', () => {
    expect(
      shouldRetryCombatStart({
        ...base,
        hasEligibleEncounter: false,
        hasEligibleNextScene: true,
      }),
    ).toBe(true);
  });

  it('contains only eligible server keys and a fixed instruction, never player text', () => {
    const nudge = structuredCombatRetryNudge(
      ['encounter-e1-lookouts', 'bad id'],
      ['scene-next', 'raw player value'],
      ['encounter-e1-lookouts'],
    );
    expect(nudge).toContain('encounter-e1-lookouts');
    expect(nudge).toContain('scene-next');
    expect(nudge).not.toContain('bad id');
    expect(nudge).not.toContain('raw player value');
    expect(nudge).not.toContain('PLAYER SECRET');
    expect(nudge).toContain('call close_scene');
    expect(nudge).toContain(
      'Never claim combat began unless start_combat succeeds.',
    );
    expect(nudge).toContain('regardless of player action');
  });
});
