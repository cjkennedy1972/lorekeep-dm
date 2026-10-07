import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { SIZE_FOOTPRINT_CELLS } from '@game/schema';
import { loadCatalog } from '../src/catalog-node.js';

const expected = JSON.parse(
  readFileSync(
    new URL('./catalog-v0-expected-counts.json', import.meta.url),
    'utf8',
  ),
);
const cat = loadCatalog();
const monsters = cat.entries.flatMap((e) =>
  e.kind === 'monster' && e.cr <= 1 ? [e] : [],
);

describe('catalog monsters CR 0-1', () => {
  // SRD 5.2.1 Monsters A-Z (pp. 258-364) has 330 stat blocks; 134 have CR <= 1.
  test('count matches expected-counts file and is 134', () => {
    expect(monsters).toHaveLength(expected.monster.low);
    expect(monsters).toHaveLength(134);
  });
  test('all are CR 0 to 1 and cite an SRD page', () => {
    for (const m of monsters) {
      expect(m.cr, m.id).toBeLessThanOrEqual(1);
      expect(m.srd.ref, m.id).toMatch(/^Monsters A-Z > .+ \(p\. \d+\)$/);
    }
  });
  test('Goblin Warrior is present with a melee and a ranged attack', () => {
    const g = cat.get('monster', 'monster:goblin-warrior');
    expect(g).toMatchObject({ cr: 0.25, hp: 10, ac: 15, size: 'small' });
    const scimitar = g?.attacks?.find((a) => a.name === 'Scimitar');
    expect(scimitar).toMatchObject({ toHit: 4, reachFt: 5 });
    expect(scimitar?.damage[0]).toEqual({ dice: '1d6+2', type: 'slashing' });
    const bow = g?.attacks?.find((a) => a.name === 'Shortbow');
    expect(bow?.range).toEqual({ normalFt: 80, longFt: 320 });
  });
  test('Goblin Boss, Minion and a ranged-only monster exist', () => {
    expect(cat.get('monster', 'monster:goblin-boss')?.cr).toBe(1);
    expect(cat.get('monster', 'monster:goblin-minion')?.cr).toBe(0.125);
    const ranged = monsters.filter((m) =>
      m.attacks?.some((a) => a.range && a.reachFt === undefined),
    );
    expect(ranged.length).toBeGreaterThan(0);
  });
  test('every attack has to-hit, reach or range band, and damage dice+type', () => {
    for (const m of monsters)
      for (const a of m.attacks ?? []) {
        const label = `${m.id} ${a.name}`;
        expect(Number.isInteger(a.toHit), label).toBe(true);
        expect(a.reachFt !== undefined || a.range !== undefined, label).toBe(
          true,
        );
        expect(a.damage.length, label).toBeGreaterThan(0);
        for (const d of a.damage) {
          expect(d.dice, label).toMatch(/^\d+(?:d\d+)?(?:[+-]\d+)?$/);
          expect(d.type, label).toMatch(/^[a-z]+$/);
        }
      }
  });
  test('size maps to a footprint in cells', () => {
    for (const m of monsters)
      expect(m.footprint, m.id).toBe(SIZE_FOOTPRINT_CELLS[m.size]);
    expect(cat.get('monster', 'monster:brown-bear')?.footprint).toBe(2);
    expect(cat.get('monster', 'monster:tarrasque')).toBeUndefined();
  });
  test('stat blocks carry hp dice matching hp average, abilities and saves', () => {
    for (const m of monsters) {
      expect(m.abilities, m.id).toBeDefined();
      const hd = /^(\d+)d(\d+)([+-]\d+)?$/.exec(m.hpDice ?? '');
      expect(hd, m.id).not.toBeNull();
      const [, n, sides, mod] = hd as RegExpExecArray;
      expect(m.hp, m.id).toBe(
        Math.floor((Number(n) * (Number(sides) + 1)) / 2) + Number(mod ?? 0),
      );
    }
  });
});
