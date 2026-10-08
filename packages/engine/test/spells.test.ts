import { describe, expect, test } from 'vitest';
import { loadCatalog } from '../src/catalog/load.js';
import type { CharacterInput } from '../src/character/types.js';
import {
  castSpell,
  concentrationSave,
  replaySpells,
  type SpellState,
} from '../src/combat/spells.js';

const catalog = loadCatalog();
const caster: CharacterInput = {
  id: 'caster',
  name: 'Mage',
  speciesId: '',
  classId: 'class:wizard',
  backgroundId: '',
  level: 5,
  abilities: { str: 8, dex: 14, con: 14, int: 18, wis: 10, cha: 10 },
  proficiencies: { skills: [], saves: ['int', 'wis'], tools: [] },
  equipment: [],
  spellsKnown: ['spell:fireball'],
  spellsPrepared: ['spell:fireball'],
  slots: {
    '1': { max: 4, used: 0 },
    '2': { max: 3, used: 0 },
    '3': { max: 2, used: 0 },
    '4': { max: 1, used: 0 },
  },
  hp: { current: 20, max: 20, temp: 0 },
  conditions: [],
};
const target = {
  id: 'target',
  hp: 100,
  maxHp: 100,
  ac: 12,
  abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
};
const initial = (): SpellState => ({
  concentration: { caster: 'spell:fly' },
  hp: { caster: 20, target: 100 },
  slots: { caster: { ...caster.slots } },
});
const opts = (extra: Partial<Parameters<typeof castSpell>[0]> = {}) => ({
  caster,
  target,
  spellId: 'spell:fireball',
  slotLevel: 3,
  seed: 123,
  catalog,
  state: initial(),
  ...extra,
});

describe('castSpell', () => {
  test('rejects a missing slot and a spell not on the caster class list', () => {
    expect(
      castSpell(
        opts({
          slotLevel: 4,
          caster: { ...caster, slots: { '1': { max: 1, used: 1 } } },
        }),
      ),
    ).toMatchObject({ error: expect.any(String), hint: expect.any(String) });
    expect(
      castSpell(opts({ caster: { ...caster, classId: 'class:cleric' } })),
    ).toMatchObject({ error: expect.any(String), hint: expect.any(String) });
  });
  test('scales upcast damage dice using the spell data', () => {
    const r = castSpell(opts({ slotLevel: 4 }));
    expect(r).toHaveProperty('ok', true);
    if ('ok' in r)
      expect(
        r.events.filter(
          (e) => e.type === 'RollEvent' && e.kind === 'damage',
        )[0],
      ).toMatchObject({ breakdown: { expression: '9d6' } });
  });
  test('replaces concentration, spends slots and replays events into the same state', () => {
    const concentrationCaster = {
      ...caster,
      classId: 'class:wizard',
      spellsPrepared: ['spell:fly'],
    };
    const r = castSpell(
      opts({ caster: concentrationCaster, spellId: 'spell:fly', slotLevel: 3 }),
    );
    expect(r).toHaveProperty('ok', true);
    if ('ok' in r) {
      expect(r.events).toContainEqual({
        type: 'ConcentrationDropped',
        entityId: 'caster',
        spellId: 'spell:fly',
      });
      expect(r.events).toContainEqual({
        type: 'ConcentrationStarted',
        entityId: 'caster',
        spellId: 'spell:fly',
      });
      expect(replaySpells(initial(), r.events)).toEqual(r.state);
      expect(r.state.concentration.caster).toBe('spell:fly');
      expect(r.state.slots.caster?.['3']?.used).toBe(1);
    }
  });
  test('failed concentration save drops concentration', () => {
    const state = initial();
    for (let seed = 0; seed < 100; seed++) {
      const r = concentrationSave('caster', 30, -1, seed, state);
      if ('ok' in r && !r.success) {
        expect(r.events.at(-1)).toEqual({
          type: 'ConcentrationDropped',
          entityId: 'caster',
          spellId: 'spell:fly',
        });
        expect(replaySpells(state, r.events).concentration.caster).toBeNull();
        return;
      }
    }
    throw new Error('expected a failed concentration save');
  });
  test('records healing and caps the result at maximum HP', () => {
    const cleric = {
      ...caster,
      classId: 'class:cleric',
      spellsKnown: ['spell:healing-word'],
      spellsPrepared: ['spell:healing-word'],
    };
    const r = castSpell(
      opts({
        caster: cleric,
        target: { ...target, hp: 19, maxHp: 20 },
        spellId: 'spell:healing-word',
        slotLevel: 1,
      }),
    );
    expect(r).toHaveProperty('ok', true);
    if ('ok' in r) expect(r.state.hp.target).toBeLessThanOrEqual(20);
  });
});
