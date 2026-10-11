import { describe, expect, it } from 'vitest';
import {
  HARD_FLOOR_VERSION,
  checkHardFloor,
} from '../../src/safety/hardFloor.js';
import {
  HARD_FLOOR_KNOWN_MISSES,
  HARD_FLOOR_NEGATIVE,
  HARD_FLOOR_POSITIVE,
} from '../fixtures/hard-floor-fixtures.js';

describe('checkHardFloor', () => {
  it.each(HARD_FLOOR_POSITIVE.map((f) => [f.id, f.text] as const))(
    'blocks %s',
    (_id, text) => {
      const result = checkHardFloor(text);
      expect(result.blocked).toBe(true);
      expect(result.rule).toMatch(
        /^(csam\.explicit-term|minor-sexual\.proximity)$/,
      );
      expect(result.version).toBe(HARD_FLOOR_VERSION);
    },
  );

  it.each(HARD_FLOOR_NEGATIVE.map((f) => [f.id, f.text] as const))(
    'allows %s',
    (_id, text) => {
      expect(checkHardFloor(text)).toEqual({
        blocked: false,
        version: HARD_FLOOR_VERSION,
      });
    },
  );

  it.each(HARD_FLOOR_KNOWN_MISSES.map((f) => [f.id, f.text] as const))(
    'known miss stays unblocked by rules (judge is second layer): %s',
    (_id, text) => {
      expect(checkHardFloor(text).blocked).toBe(false);
    },
  );

  it('returns the same verdict on repeated calls (tier-independent, text-only)', () => {
    for (const f of [...HARD_FLOOR_POSITIVE, ...HARD_FLOOR_NEGATIVE]) {
      expect(checkHardFloor(f.text)).toEqual(checkHardFloor(f.text));
    }
  });

  it('exposes the rule version string', () => {
    expect(HARD_FLOOR_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/);
  });
});
