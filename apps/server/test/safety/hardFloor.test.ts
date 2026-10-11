import { describe, expect, it } from 'vitest';
import {
  HARD_FLOOR_VERSION,
  MAX_INPUT_CHARS,
  checkHardFloor,
} from '../../src/safety/hardFloor.js';
import {
  HARD_FLOOR_KNOWN_FALSE_POSITIVES,
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

  it.each(HARD_FLOOR_KNOWN_FALSE_POSITIVES.map((f) => [f.id, f.text] as const))(
    'known false positive stays blocked (documented cost of unconditional "minor"): %s',
    (_id, text) => {
      expect(checkHardFloor(text).blocked).toBe(true);
    },
  );

  it('returns the same verdict on repeated calls (tier-independent, text-only)', () => {
    for (const f of [...HARD_FLOOR_POSITIVE, ...HARD_FLOOR_NEGATIVE]) {
      expect(checkHardFloor(f.text)).toEqual(checkHardFloor(f.text));
    }
  });

  it('handles adversarial long input in linear time', () => {
    const cases = [
      'kid sexual '.repeat(1800),
      'child '.repeat(1800) + 'x'.repeat(1000),
      'a '.repeat(9900),
      's e x '.repeat(3300),
      'ch1ld 1 '.repeat(2300),
      ('kid ' + 'word '.repeat(5)).repeat(650),
    ];
    for (const text of cases) {
      expect(text.length).toBeLessThanOrEqual(MAX_INPUT_CHARS);
      const start = performance.now();
      checkHardFloor(text);
      expect(performance.now() - start).toBeLessThan(1000);
    }
  });

  it('blocks input over the hard cap without scanning it', () => {
    const text = 'word '.repeat(100_000);
    const start = performance.now();
    expect(checkHardFloor(text)).toMatchObject({
      blocked: true,
      rule: 'input.over-limit',
    });
    expect(performance.now() - start).toBeLessThan(50);
  });

  it('scales linearly: 10x input costs well under 40x time', () => {
    const run = (n: number) => {
      const text = 'the kid walks home '.repeat(n);
      const start = performance.now();
      for (let i = 0; i < 5; i++) checkHardFloor(text);
      return performance.now() - start;
    };
    run(100);
    const small = run(100);
    const big = run(1000);
    expect(big).toBeLessThan(Math.max(small, 1) * 40);
  });

  it('exposes the rule version string', () => {
    expect(HARD_FLOOR_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/);
  });
});
