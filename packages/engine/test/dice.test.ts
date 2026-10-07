import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  abilityModifier,
  proficiencyBonus,
  roll,
  seedRng,
  nextDie,
} from '../src/index.js';

describe('determinism', () => {
  test('same seed and inputs give identical rolls', () => {
    const run = () => {
      let s = seedRng(42);
      const out = [];
      for (let i = 0; i < 20; i++) {
        const [b, n] = roll('3d6+2', s);
        out.push(b);
        s = n;
      }
      return out;
    };
    expect(run()).toEqual(run());
    expect(roll('1d20', seedRng(1))[0]).not.toEqual(
      roll('1d20', seedRng(2))[0],
    );
  });
});

describe('advantage/disadvantage', () => {
  test('lists both dice and marks the dropped one', () => {
    for (const mode of ['advantage', 'disadvantage'] as const) {
      for (let seed = 0; seed < 50; seed++) {
        const [b] = roll('1d20', seedRng(seed), { mode });
        expect(b.dice).toHaveLength(2);
        const kept = b.dice.filter((d) => d.kept);
        const dropped = b.dice.filter((d) => !d.kept);
        expect(kept).toHaveLength(1);
        expect(dropped).toHaveLength(1);
        const cmp =
          mode === 'advantage'
            ? kept[0]!.value >= dropped[0]!.value
            : kept[0]!.value <= dropped[0]!.value;
        expect(cmp).toBe(true);
      }
    }
  });
  test('keep-highest', () => {
    const [b] = roll('4d6kh3', seedRng(7));
    expect(b.dice).toHaveLength(4);
    expect(b.dice.filter((d) => d.kept)).toHaveLength(3);
  });
});

test('total equals kept dice plus labelled modifiers (1000 runs)', () => {
  let s = seedRng(2024);
  const exprs = ['1d20', '2d6+3', '4d6kh3', '3d8-1', '2d10kl1+2'];
  for (let i = 0; i < 1000; i++) {
    const expr = exprs[i % exprs.length]!;
    const mode =
      expr === '1d20'
        ? (['normal', 'advantage', 'disadvantage'] as const)[i % 3]
        : 'normal';
    const [b, n] = roll(expr, s, {
      mode,
      modifiers: [{ label: 'STR', value: (i % 7) - 3 }],
    });
    s = n;
    const kept = b.dice.filter((d) => d.kept).reduce((a, d) => a + d.value, 0);
    expect(b.total).toBe(kept + b.modifiers.reduce((a, m) => a + m.value, 0));
    for (const m of b.modifiers) expect(m.label.length).toBeGreaterThan(0);
    for (const d of b.dice) expect(d.value).toBeGreaterThanOrEqual(1);
  }
});

test('helpers', () => {
  expect([1, 8, 10, 11, 20, 30].map(abilityModifier)).toEqual([
    -5, -1, 0, 0, 5, 10,
  ]);
  expect([1, 4, 5, 9, 13, 17, 20].map(proficiencyBonus)).toEqual([
    2, 2, 3, 4, 5, 6, 6,
  ]);
});

test('invalid expressions throw', () => {
  expect(() => roll('d', seedRng(1))).toThrow();
  expect(() => roll('2d6', seedRng(1), { mode: 'advantage' })).toThrow();
});

// H2: Test dice count/sides bounds
describe('dice bounds', () => {
  test('rejects count > MAX_DICE_COUNT', () => {
    expect(() => roll('101d6', seedRng(1))).toThrow(
      /dice count must be a safe integer between 1 and 100/,
    );
    expect(() => roll('1000000d6', seedRng(1))).toThrow(
      /dice count must be a safe integer between 1 and 100/,
    );
  });

  test('rejects sides > MAX_DICE_SIDES', () => {
    expect(() => roll('1d1001', seedRng(1))).toThrow(
      /dice sides must be a safe integer between 1 and 1000/,
    );
    expect(() => roll('1d4294967297', seedRng(1))).toThrow(
      /dice sides must be a safe integer between 1 and 1000/,
    );
  });

  test('rejects count = 0', () => {
    expect(() => roll('0d6', seedRng(1))).toThrow(
      /dice count must be a safe integer between 1 and 100/,
    );
  });

  test('rejects sides = 0', () => {
    expect(() => roll('1d0', seedRng(1))).toThrow(
      /dice sides must be a safe integer between 1 and 1000/,
    );
  });

  test('rejects negative count', () => {
    expect(() => roll('-1d6', seedRng(1))).toThrow(/invalid dice expression/);
  });

  test('rejects negative sides', () => {
    expect(() => roll('1d-6', seedRng(1))).toThrow(/invalid dice expression/);
  });

  test('accepts max bounds (100d1000)', () => {
    const [b] = roll('100d1000', seedRng(42));
    expect(b.dice).toHaveLength(100);
    expect(b.total).toBeGreaterThanOrEqual(100);
    expect(b.total).toBeLessThanOrEqual(100000);
  });
});

// L1: Test expression normalization is preserved in breakdown
describe('expression normalization', () => {
  test('stores normalized expression (lowercase, no whitespace)', () => {
    const [b] = roll('4D6 KH 3', seedRng(1));
    expect(b.expression).toBe('4d6kh3');
  });

  test('preserves original in error message for user feedback', () => {
    // Test with a valid expression that throws on modifiers (not count validation)
    // This ensures the expression appears in error context
    try {
      roll('1d20+5+2', seedRng(1)); // Multiple modifiers in expression
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      expect(msg).toContain('1d20+5+2');
    }
  });
});

// L2: Test modifier handling
describe('modifier handling', () => {
  test('rejects multiple modifiers in expression (e.g., 1d20+5+2)', () => {
    expect(() => roll('1d20+5+2', seedRng(1))).toThrow(
      /invalid dice expression/,
    );
  });

  test('accepts single modifier via expression', () => {
    const [b] = roll('1d20+5', seedRng(1));
    expect(b.modifiers).toHaveLength(1);
    expect(b.modifiers[0]).toEqual({ label: 'expression', value: 5 });
  });
});

test('no Math.random or Date in src', () => {
  const dir = join(import.meta.dirname, '../src');
  for (const f of readdirSync(dir, { recursive: true })
    .map(String)
    .filter((f) => f.endsWith('.ts'))) {
    expect(readFileSync(join(dir, f), 'utf8'), f).not.toMatch(
      /Math\.random|\bDate\b/,
    );
  }
});

// M1: RNG seed validation tests
describe('seedRng seed validation', () => {
  test('accepts valid uint32 seeds (0 to 2^32-1)', () => {
    expect(seedRng(0)).toBe(0);
    expect(seedRng(42)).toBe(42);
    expect(seedRng(0xffffffff)).toBe(0xffffffff);
    expect(seedRng(123456789)).toBe(123456789);
  });

  test('rejects NaN', () => {
    expect(() => seedRng(NaN)).toThrow(/RNG seed must be an integer/);
  });

  test('rejects floats/non-integers', () => {
    expect(() => seedRng(1.9)).toThrow(/RNG seed must be an integer/);
    expect(() => seedRng(3.14)).toThrow(/RNG seed must be an integer/);
    expect(() => seedRng(0.5)).toThrow(/RNG seed must be an integer/);
  });

  test('rejects Infinity', () => {
    expect(() => seedRng(Infinity)).toThrow(/RNG seed must be an integer/);
  });

  test('rejects -Infinity', () => {
    expect(() => seedRng(-Infinity)).toThrow(/RNG seed must be an integer/);
  });

  test('rejects negative seeds', () => {
    expect(() => seedRng(-1)).toThrow(/RNG seed must be non-negative/);
    expect(() => seedRng(-42)).toThrow(/RNG seed must be non-negative/);
    expect(() => seedRng(-0xffffffff)).toThrow(/RNG seed must be non-negative/);
  });

  test('rejects seeds > 2^32-1', () => {
    expect(() => seedRng(0x100000000)).toThrow(/RNG seed must be <= 2\^32-1/);
    expect(() => seedRng(4294967296)).toThrow(/RNG seed must be <= 2\^32-1/);
    expect(() => seedRng(10000000000)).toThrow(/RNG seed must be <= 2\^32-1/);
  });

  test('deterministic: same seed produces same sequence', () => {
    const run = (seed: number) => {
      let s = seedRng(seed);
      const out: number[] = [];
      for (let i = 0; i < 10; i++) {
        const [val, next] = nextDie(s, 20);
        out.push(val);
        s = next;
      }
      return out;
    };
    expect(run(42)).toEqual(run(42));
    expect(run(42)).not.toEqual(run(43));
  });
});

// M2: Golden-vector test for mulberry32 algorithm
describe('rng golden vector', () => {
  test('mulberry32 produces expected first 10 d20 values with seed 42', () => {
    let s = seedRng(42);
    const results: number[] = [];
    for (let i = 0; i < 10; i++) {
      const [val, next] = nextDie(s, 20);
      results.push(val);
      s = next;
    }
    // This is the golden vector for mulberry32(seed=42) rolling d20 ten times
    // Update this when the RNG algorithm changes
    expect(results).toEqual([13, 9, 18, 14, 4, 11, 6, 13, 18, 10]);
  });
});

// M2: Coarse uniformity test (non-flaky chi-square approximation)
describe('rng uniformity regression', () => {
  test('d20 distribution is roughly uniform (10000 rolls)', () => {
    let s = seedRng(12345);
    const counts = new Array(20).fill(0);
    for (let i = 0; i < 10000; i++) {
      const [val, next] = nextDie(s, 20);
      counts[val - 1]!++;
      s = next;
    }
    const expected = 10000 / 20; // 500
    const tolerance = expected * 0.2; // ±20%
    for (let i = 0; i < 20; i++) {
      expect(counts[i]).toBeGreaterThanOrEqual(expected - tolerance);
      expect(counts[i]).toBeLessThanOrEqual(expected + tolerance);
    }
  });
});
