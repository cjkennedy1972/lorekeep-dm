import { describe, expect, test } from 'vitest';
import { loadCatalog } from '../src/catalog-node.js';

const cat = loadCatalog();
const classes = cat.entries.filter((e) => e.kind === 'class');
const subclasses = cat.entries.filter((e) => e.kind === 'subclass');
const names = ['paladin', 'ranger', 'rogue', 'sorcerer', 'warlock', 'wizard'];
const get = (n: string) => {
  const c = classes.find((e) => e.id === `class:${n}`);
  if (c?.kind !== 'class') throw new Error(n);
  return c;
};

describe('catalog classes B (Paladin..Wizard)', () => {
  test('all twelve classes load', () => {
    expect(classes).toHaveLength(12);
    for (const n of names) expect(get(n).id).toBe(`class:${n}`);
  });
  test('each class has features for levels 1-5', () => {
    for (const n of names) {
      const levels = new Set(get(n).features?.map((f) => f.level));
      for (const l of [1, 2, 3, 4, 5]) {
        // SRD 5.2.1 Warlock table lists no class feature at level 5 ("—").
        if (n === 'warlock' && l === 5) continue;
        expect(levels.has(l), `${n} L${l}`).toBe(true);
      }
    }
  });
  test('each class has exactly one subclass', () => {
    for (const c of classes)
      expect(
        subclasses.filter((s) => s.kind === 'subclass' && s.classId === c.id),
        c.id,
      ).toHaveLength(1);
    expect(subclasses).toHaveLength(12);
  });
  test('slot tables per SRD 5.2.1', () => {
    const half = [[2], [2], [3], [3], [4, 2]];
    expect(get('paladin').spellSlots).toEqual(half);
    expect(get('ranger').spellSlots).toEqual(half);
    expect(get('rogue').spellSlots).toBeUndefined();
    for (const n of ['sorcerer', 'wizard'])
      expect(get(n).spellSlots).toEqual([[2], [3], [4, 2], [4, 3], [4, 3, 2]]);
    expect(get('warlock').spellSlots).toBeUndefined();
  });
  test('sorcery points and pact magic are schema fields', () => {
    expect(get('sorcerer').sorceryPoints).toEqual([0, 2, 3, 4, 5]);
    expect(get('warlock').pactMagic).toEqual([
      { slots: 1, slotLevel: 1 },
      { slots: 2, slotLevel: 1 },
      { slots: 2, slotLevel: 2 },
      { slots: 2, slotLevel: 2 },
      { slots: 2, slotLevel: 3 },
    ]);
  });
  test('cantrips and prepared spells per SRD 5.2.1', () => {
    expect(get('paladin').preparedSpells).toEqual([2, 3, 4, 5, 6]);
    expect(get('ranger').preparedSpells).toEqual([2, 3, 4, 5, 6]);
    expect(get('sorcerer').cantripsKnown).toEqual([4, 4, 4, 5, 5]);
    expect(get('sorcerer').preparedSpells).toEqual([2, 4, 6, 7, 9]);
    expect(get('warlock').cantripsKnown).toEqual([2, 2, 2, 3, 3]);
    expect(get('warlock').preparedSpells).toEqual([2, 3, 4, 5, 6]);
    expect(get('wizard').cantripsKnown).toEqual([3, 3, 4, 4, 4]);
    expect(get('wizard').preparedSpells).toEqual([4, 5, 6, 7, 9]);
  });
  test('feature ids are unique across all classes and subclasses', () => {
    const ids = [...classes, ...subclasses].flatMap((e) =>
      e.kind === 'class' || e.kind === 'subclass'
        ? (e.features ?? []).map((f) => f.id)
        : [],
    );
    expect(new Set(ids).size).toBe(ids.length);
  });
});
