import { describe, expect, it } from 'vitest';
import {
  shouldRetryCombatStart,
  structuredCombatRetryNudge,
} from '../../src/dm/combatRetry.js';

describe('structured combat retry control', () => {
  const base = {
    hasEligibleEncounter: true,
    hostileEngagementSignal: true,
    startToolAttempted: false,
    sceneClosed: false,
    alreadyRetried: false,
    outputRefused: false,
  };

  it('retries an eligible hostile encounter once, but not after a start attempt or close', () => {
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
  });

  it('does not retry just because an encounter is offered', () => {
    expect(
      shouldRetryCombatStart({ ...base, hostileEngagementSignal: false }),
    ).toBe(false);
  });

  it('does not retry a scene transition without a hostile encounter intent', () => {
    expect(
      shouldRetryCombatStart({ ...base, hostileEngagementSignal: false }),
    ).toBe(false);
  });

  it('contains only eligible server keys and fixed instructions', () => {
    const nudge = structuredCombatRetryNudge(
      ['encounter-e1-lookouts', 'bad id'],
      ['encounter-e1-lookouts'],
    );
    expect(nudge).toContain('encounter-e1-lookouts');
    expect(nudge).not.toContain('bad id');
    expect(nudge).not.toContain('PLAYER SECRET');
    expect(nudge).toContain(
      'Never claim combat began unless start_combat succeeds.',
    );
    expect(nudge).toContain('regardless of player action');
  });
});
