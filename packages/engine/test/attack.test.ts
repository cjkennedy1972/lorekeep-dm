import { describe, expect, test } from 'vitest';
import { nextDie } from '../src/rng.js';
import {
  applyDamageRelation,
  attack,
  type AttackInput,
  type AttackResult,
} from '../src/combat/attack.js';

const base: AttackInput = {
  attackerId: 'a',
  targetId: 'b',
  attackId: 'sword',
  seed: 0,
  attackBonus: 5,
  damage: '1d8+3',
  damageType: 'slashing',
  targetAc: 15,
  target: { hp: 20, kind: 'monster' },
};
const ok = (r: AttackResult) => {
  if (!('ok' in r)) throw new Error(r.error);
  return r;
};
const natOf = (seed: number) => nextDie(seed, 20)[0];
const seedWith = (pred: (n: number) => boolean) => {
  for (let s = 0; ; s++) if (pred(natOf(s))) return s;
};

describe('attack', () => {
  test('natural 20 hits regardless of AC and doubles damage dice', () => {
    const seed = seedWith((n) => n === 20);
    const r = ok(attack({ ...base, seed, targetAc: 99 }));
    expect(r.hit && r.crit).toBe(true);
    const dmg = r.events.find(
      (e) => e.type === 'RollEvent' && e.kind === 'damage',
    );
    expect(dmg && 'breakdown' in dmg && dmg.breakdown.dice).toHaveLength(2);
  });
  test('natural 1 misses regardless of bonus', () => {
    const seed = seedWith((n) => n === 1);
    const r = ok(attack({ ...base, seed, attackBonus: 50, targetAc: 1 }));
    expect(r.hit).toBe(false);
    expect(r.events.map((e) => e.type)).toEqual(['RollEvent']);
  });
  test('every RollEvent breakdown total equals the sum of its parts', () => {
    const seed = seedWith((n) => n >= 10 && n < 20);
    const r = ok(attack({ ...base, seed, targetAc: 1 }));
    for (const e of r.events) {
      if (e.type !== 'RollEvent') continue;
      const sum =
        e.breakdown.dice
          .filter((d) => d.kept)
          .reduce((s, d) => s + d.value, 0) +
        e.breakdown.modifiers.reduce((s, m) => s + m.value, 0);
      expect(e.breakdown.total).toBe(sum);
    }
  });
  test('advantage rolls two d20 and keeps one', () => {
    const r = ok(attack({ ...base, mode: 'advantage' }));
    const e = r.events[0]!;
    expect(e.type === 'RollEvent' && e.breakdown.dice).toHaveLength(2);
  });
  test('cover raises effective AC', () => {
    const seed = seedWith((n) => n >= 5 && n < 19);
    const ac = natOf(seed) + base.attackBonus;
    expect(ok(attack({ ...base, seed, targetAc: ac })).hit).toBe(true);
    expect(
      ok(attack({ ...base, seed, targetAc: ac, coverAcBonus: 2 })).hit,
    ).toBe(false);
  });
  test('dropping to 0 HP emits HpChanged then down outcome by kind', () => {
    const seed = seedWith((n) => n >= 10 && n < 20);
    const pc = ok(
      attack({ ...base, seed, targetAc: 1, target: { hp: 1, kind: 'pc' } }),
    );
    expect(pc.events.slice(-2).map((e) => e.type)).toEqual([
      'HpChanged',
      'EntityDown',
    ]);
    expect(pc.events.at(-1)).toMatchObject({ outcome: 'unconscious' });
    const mon = ok(
      attack({
        ...base,
        seed,
        targetAc: 1,
        target: { hp: 1, kind: 'monster' },
      }),
    );
    expect(mon.events.at(-1)).toMatchObject({ outcome: 'dead' });
    expect(mon.events.at(-2)).toMatchObject({ type: 'HpChanged', to: 0 });
  });
  test('immune target takes 0 and stays up', () => {
    const seed = seedWith((n) => n >= 10 && n < 20);
    const r = ok(
      attack({
        ...base,
        seed,
        targetAc: 1,
        target: { hp: 5, kind: 'pc', relations: { slashing: 'immune' } },
      }),
    );
    expect(r.events.at(-1)).toMatchObject({
      type: 'HpChanged',
      to: 5,
      damage: 0,
    });
  });
  test('rejects self-target', () => {
    expect('error' in attack({ ...base, targetId: 'a' })).toBe(true);
  });
});

describe('applyDamageRelation', () => {
  test.each([
    [7, undefined, 7],
    [7, 'resistant', 3],
    [8, 'resistant', 4],
    [1, 'resistant', 0],
    [7, 'vulnerable', 14],
    [7, 'immune', 0],
    [0, 'vulnerable', 0],
  ] as const)('%i %s -> %i', (amt, rel, out) => {
    expect(applyDamageRelation(amt, rel)).toBe(out);
  });
});
