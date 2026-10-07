import { describe, expect, test } from 'vitest';
import { loadCatalog } from '../src/index.js';

const cat = loadCatalog();
const classes = cat.entries.filter((e) => e.kind === 'class');
const subclasses = cat.entries.filter((e) => e.kind === 'subclass');
const casters = ['bard', 'cleric', 'druid'];

describe('catalog classes A (Barbarian..Monk)', () => {
  test('six classes load with SRD ids', () => {
    expect(classes.map((c) => c.id).sort()).toEqual(
      ['barbarian', 'bard', 'cleric', 'druid', 'fighter', 'monk'].map(
        (n) => `class:${n}`,
      ),
    );
  });
  test('each class has features for levels 1-5', () => {
    for (const c of classes) {
      if (c.kind !== 'class') continue;
      const levels = new Set(c.features?.map((f) => f.level));
      for (const l of [1, 2, 3, 4, 5])
        expect(levels.has(l), `${c.id} L${l}`).toBe(true);
    }
  });
  test('casters have slot tables for levels 1-5; others have none', () => {
    for (const c of classes) {
      if (c.kind !== 'class') continue;
      if (casters.some((n) => c.id === `class:${n}`)) {
        expect(c.spellSlots).toEqual([[2], [3], [4, 2], [4, 3], [4, 3, 2]]);
        expect(c.cantripsKnown).toHaveLength(5);
        expect(c.preparedSpells).toHaveLength(5);
        expect(c.spellcastingAbility).toBeDefined();
      } else expect(c.spellSlots).toBeUndefined();
    }
  });
  test('each class has exactly one subclass', () => {
    for (const c of classes) {
      const subs = subclasses.filter(
        (s) => s.kind === 'subclass' && s.classId === c.id,
      );
      expect(subs, c.id).toHaveLength(1);
    }
    expect(subclasses).toHaveLength(classes.length);
  });
  test('feature ids are unique across classes and subclasses', () => {
    const ids = [...classes, ...subclasses].flatMap((e) =>
      e.kind === 'class' || e.kind === 'subclass'
        ? (e.features ?? []).map((f) => f.id)
        : [],
    );
    expect(new Set(ids).size).toBe(ids.length);
  });
});
