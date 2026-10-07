import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  abilityModifier,
  proficiencyBonus,
  roll,
  seedRng,
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
