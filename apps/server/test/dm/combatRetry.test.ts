import { describe, expect, it } from 'vitest';
import {
  shouldRetryCombatStart,
  structuredCombatRetryNudge,
} from '../../src/dm/combatRetry.js';

describe('structured combat retry control', () => {
  const base = {
    hasEligibleEncounter: true,
    hasEligibleNextScene: false,
    hostileEngagementSignal: true,
    sceneProgressionRetryEnabled: false,
    sceneProgressionSignal: false,
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

  it('keeps scene progression disabled unless explicitly enabled', () => {
    const sceneOnly = {
      ...base,
      hasEligibleEncounter: false,
      hasEligibleNextScene: true,
    };
    expect(shouldRetryCombatStart(sceneOnly)).toBe(false);
    expect(
      shouldRetryCombatStart({
        ...sceneOnly,
        sceneProgressionRetryEnabled: true,
        sceneProgressionSignal: true,
      }),
    ).toBe(true);
  });

  it('omits scene-close instructions when no next scenes are offered', () => {
    expect(structuredCombatRetryNudge(['encounter-e1-lookouts'])).not.toContain(
      'close_scene',
    );
  });

  it('contains only eligible server keys and fixed instructions', () => {
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
