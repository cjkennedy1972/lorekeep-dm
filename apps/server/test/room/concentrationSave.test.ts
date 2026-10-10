import { concentrationSave, type SpellState } from '@game/rules-engine';
import { describe, expect, it } from 'vitest';
import { withHp } from '../../src/room/combatEngine.js';
import type { RoomCombatState } from '../../src/room/combatTypes.js';

const SPELL = 'srd:spell/bless';
const goblin = (con = 10) => ({
  id: 'ent_goblin',
  kind: 'monster',
  team: 'goblins',
  pos: { x: 0, y: 0 },
  size: 1,
  hp: 40,
  maxHp: 40,
  abilities: { str: 10, dex: 10, con, int: 10, wis: 10, cha: 10 },
});
const stateWith = (seed: number, con = 10) =>
  ({
    entities: [goblin(con)],
    combat: { round: 1, activeEntityId: null, initiative: [], resources: {} },
    concentration: { ent_goblin: SPELL },
    seed,
  }) as unknown as RoomCombatState;
const hit = (from: number, to: number) => ({
  type: 'HpChanged',
  entityId: 'ent_goblin',
  from,
  to,
  damage: from - to,
  damageType: 'slashing',
});
const spellState: SpellState = {
  concentration: { ent_goblin: SPELL },
  hp: {},
  slots: {},
};
const saveTotal = (seed: number, damage: number) => {
  const r = concentrationSave('ent_goblin', damage, 0, seed, spellState);
  if (!('ok' in r)) throw new Error(r.hint);
  return r;
};
const seedWhere = (damage: number, want: boolean) => {
  for (let seed = 0; seed < 500; seed++)
    if (saveTotal(seed, damage).success === want) return seed;
  throw new Error('no seed found');
};

describe('concentration after damage', () => {
  it('keeps concentration when the CON save succeeds', () => {
    const seed = seedWhere(4, true);
    const next = withHp(stateWith(seed), [hit(40, 36)]);
    expect(next.state.concentration?.ent_goblin).toBe(SPELL);
    expect(next.events.map((e) => e.type)).toEqual(['RollEvent']);
    expect(next.state.seed).not.toBe(seed);
  });

  it('ends concentration when the CON save fails', () => {
    const seed = seedWhere(4, false);
    const next = withHp(stateWith(seed), [hit(40, 36)]);
    expect(next.state.concentration?.ent_goblin).toBeNull();
    expect(next.events.map((e) => e.type)).toEqual([
      'RollEvent',
      'ConcentrationDropped',
    ]);
  });

  it('uses DC max(10, floor(damage / 2))', () => {
    for (let seed = 0; seed < 60; seed++) {
      const next = withHp(stateWith(seed), [hit(60, 30)]);
      const roll = next.events.find((e) => e.type === 'RollEvent') as {
        breakdown: { total: number };
      };
      expect(next.state.concentration?.ent_goblin === null).toBe(
        roll.breakdown.total < 15,
      );
    }
  });

  it('ends concentration at 0 HP without a save', () => {
    const next = withHp(stateWith(1), [hit(4, 0)]);
    expect(next.state.concentration?.ent_goblin).toBeNull();
    expect(next.events.some((e) => e.type === 'RollEvent')).toBe(false);
  });

  it('rolls a separate save for each damage instance', () => {
    const next = withHp(stateWith(1), [hit(40, 36), hit(36, 30)]);
    expect(next.events.filter((e) => e.type === 'RollEvent')).toHaveLength(2);
  });

  it('applies the constitution modifier to the save', () => {
    const seed = 3;
    const plain = withHp(stateWith(seed, 10), [hit(40, 36)]);
    const tough = withHp(stateWith(seed, 20), [hit(40, 36)]);
    const total = (r: typeof plain) =>
      (
        r.events.find((e) => e.type === 'RollEvent') as {
          breakdown: { total: number };
        }
      ).breakdown.total;
    expect(total(tough)).toBe(total(plain) + 5);
  });
});
