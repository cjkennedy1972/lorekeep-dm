import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { loadCatalog } from '../src/index.js';

const expected = JSON.parse(
  readFileSync(
    new URL('./catalog-v0-expected-counts.json', import.meta.url),
    'utf8',
  ),
);
const cat = loadCatalog();
const of = (k: string) => cat.entries.filter((e) => e.kind === k);

describe('catalog v0 content', () => {
  test('counts match expected-counts file', () => {
    expect(of('species')).toHaveLength(expected.species);
    expect(of('background')).toHaveLength(expected.background);
    expect(of('condition')).toHaveLength(expected.condition);
    expect(of('class')).toHaveLength(expected.class);
    expect(of('subclass')).toHaveLength(expected.subclass);
    for (const c of ['weapon', 'armor', 'gear'])
      expect(
        of('equipment').filter(
          (e) => e.kind === 'equipment' && e.category === c,
        ),
      ).toHaveLength(expected.equipment[c]);
  });
  test('every entry cites an SRD section', () => {
    for (const e of cat.entries) expect(e.srd.ref).toMatch(/ > /);
  });
  test('backgrounds list 3 ability options and two skills', () => {
    for (const e of of('background'))
      if (e.kind === 'background') {
        expect(e.abilityOptions).toHaveLength(3);
        expect(e.skillProficiencies).toHaveLength(2);
      }
  });
  test('every referenced condition id resolves', () => {
    for (const e of of('species'))
      if (e.kind === 'species')
        for (const r of e.conditionRefs ?? [])
          expect(cat.get('condition', r), r).toBeDefined();
  });
});
