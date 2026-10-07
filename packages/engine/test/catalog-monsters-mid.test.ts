import { readFileSync } from 'node:fs';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
const monsters = cat.entries.flatMap((e) => (e.kind === 'monster' ? [e] : []));
const mid = monsters.filter((m) => m.cr >= 2 && m.cr <= 5);

// SRD 5.2.1 Monsters A-Z (pp. 258-364): CR 2 = 42, CR 3 = 25, CR 4 = 16, CR 5 = 25.
const BUCKETS: Record<number, number> = { 2: 42, 3: 25, 4: 16, 5: 25 };

describe('catalog monsters CR 2-5', () => {
  test('count matches expected-counts file and is 108', () => {
    expect(mid).toHaveLength(expected.monster.mid);
    expect(mid).toHaveLength(108);
    expect(expected.monster.total).toBe(242);
    expect(expected.monster.low).toBe(134);
  });
  test('CR buckets match SRD and every entry cites an SRD page', () => {
    for (const [cr, n] of Object.entries(BUCKETS)) {
      expect(mid.filter((m) => m.cr === Number(cr))).toHaveLength(n);
    }
    for (const m of mid) {
      expect(m.cr, m.id).toBeGreaterThanOrEqual(2);
      expect(m.cr, m.id).toBeLessThanOrEqual(5);
      expect(m.srd.ref, m.id).toMatch(/^Monsters A-Z > .+ \(p\. \d+\)$/);
    }
  });
  test('every mid entry carries the new structured fields', () => {
    for (const m of mid) {
      expect(Array.isArray(m.attacks), `${m.id} attacks`).toBe(true);
      // Multiattack must be a structured list of attack ids, not prose.
      expect(Array.isArray(m.multiattack), `${m.id} multiattack`).toBe(true);
      const ids = (m.attacks ?? []).map((a) => a.id);
      for (const step of m.multiattack ?? []) {
        expect(ids, `${m.id} step ${step.attackId}`).toContain(step.attackId);
        expect(step.count, m.id).toBeGreaterThan(0);
      }
      // No prose "Multiattack" trait should remain.
      for (const t of m.traits ?? [])
        expect(t.name, `${m.id} ${t.name}`).not.toBe('Multiattack');
      // Every attack has an id.
      for (const a of m.attacks ?? [])
        expect(a.id, `${m.id} ${a.name}`).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    }
  });
  test('save-based actions and traits are structured', () => {
    for (const m of mid) {
      const saveables = [
        ...(m.traits ?? []),
        ...(m.attacks ?? []).filter(Boolean),
      ];
      for (const s of saveables) {
        const hasThrow = /Saving Throw/.test(s.text ?? '');
        if (hasThrow) {
          expect(s.save, `${m.id} ${s.name}`).toBeDefined();
          expect(s.save?.ability, m.id).toMatch(/^(str|dex|con|int|wis|cha)$/);
          expect(s.save?.dc, m.id).toBeGreaterThan(0);
        }
      }
    }
  });
  test('every attack has to-hit, reach or range band, and damage dice+type', () => {
    for (const m of mid)
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
    for (const m of mid)
      expect(m.footprint, m.id).toBe(SIZE_FOOTPRINT_CELLS[m.size]);
  });
  test('stat blocks carry hp dice matching hp average, abilities and saves', () => {
    for (const m of mid) {
      expect(m.abilities, m.id).toBeDefined();
      const hd = /^(\d+)d(\d+)([+-]\d+)?$/.exec(m.hpDice ?? '');
      expect(hd, m.id).not.toBeNull();
      const [, n, sides, mod] = hd as RegExpExecArray;
      expect(m.hp, m.id).toBe(
        Math.floor((Number(n) * (Number(sides) + 1)) / 2) + Number(mod ?? 0),
      );
    }
  });
  test('a structured multiattack is used where SRD has one (e.g. Troll)', () => {
    const troll = cat.get('monster', 'monster:troll');
    expect(troll).toBeDefined();
    expect(troll?.multiattack?.length).toBeGreaterThan(0);
    expect(cat.get('monster', 'monster:hill-giant')?.multiattack?.length).toBe(
      2,
    );
  });
  test('CR 6 is rejected by the scope gate', () => {
    const base = {
      catalogVersion: '1',
      srd: { source: 'SRD 5.2.1', ref: 'x' },
      id: 'monster:ogre-cr6',
      kind: 'monster',
      name: 'Ogre',
      cr: 6,
      hp: 10,
      ac: 12,
      speed: 30,
      size: 'medium',
    };
    const d = mkdtempSync(join(tmpdir(), 'cat-'));
    writeFileSync(join(d, 'cr6.json'), JSON.stringify([base]));
    expect(() => loadCatalog(d)).toThrow(/monster CR 6/);
  });
});
