import { describe, expect, it } from 'vitest';
import {
  HARD_FLOOR_VERSION,
  MAX_INPUT_CHARS,
  checkHardFloor,
  variantCacheStats,
} from '../../src/safety/hardFloor.js';
import {
  HARD_FLOOR_KNOWN_FALSE_POSITIVES,
  HARD_FLOOR_KNOWN_MISSES,
  HARD_FLOOR_NEGATIVE,
  HARD_FLOOR_POSITIVE,
} from '../fixtures/hard-floor-fixtures.js';
import { medianMs } from '../fixtures/timing.js';

const ABSOLUTE_CEILING_MS = 500;

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
    const units = [
      'kid sexual ',
      'child ',
      'a ',
      's e x ',
      'ch1ld 1 ',
      'kid word word word word word ',
    ];
    const sized = (unit: string, n: number) =>
      unit.repeat(Math.ceil(n / unit.length)).slice(0, n);
    for (const unit of units) {
      const half = sized(unit, MAX_INPUT_CHARS / 2);
      const full = sized(unit, MAX_INPUT_CHARS);
      const halfMs = medianMs(() => checkHardFloor(half));
      const fullMs = medianMs(() => checkHardFloor(full));
      expect(fullMs / halfMs, `scaling for ${unit}`).toBeLessThan(3);
      expect(fullMs, `ceiling for ${unit}`).toBeLessThan(ABSOLUTE_CEILING_MS);
    }
  });

  it('rejects input over the hard cap without scanning it', () => {
    const over = 'word '.repeat(100_000);
    const atCap = 'word '.repeat(MAX_INPUT_CHARS / 5);
    expect(checkHardFloor(over)).toMatchObject({
      blocked: true,
      rule: 'input.over-limit',
    });
    expect(medianMs(() => checkHardFloor(over)) * 10).toBeLessThan(
      medianMs(() => checkHardFloor(atCap)),
    );
  });

  it('bounds the variant cache by characters as well as entries', () => {
    let peak = 0;
    for (let i = 0; i < 150; i++) {
      const word = String.fromCharCode(
        97 + (i % 26),
        97 + Math.floor(i / 26),
      ).padEnd(30_000, 'q');
      checkHardFloor(word);
      peak = Math.max(peak, variantCacheStats().chars);
    }
    expect(variantCacheStats().entries).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(2_000_000);
    expect(peak * 2).toBeLessThanOrEqual(8 * 1024 * 1024);
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
