import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { loadCatalog } from '../src/catalog-node.js';

const base = {
  catalogVersion: '1',
  srd: { source: 'SRD 5.2.1', ref: 'x' },
};
const spell = (id: string, level: number) => ({
  ...base,
  id,
  kind: 'spell',
  name: id,
  level,
  school: 'evocation',
  classes: [],
});
const monster = (id: string, cr: number) => ({
  ...base,
  id,
  kind: 'monster',
  name: id,
  cr,
  hp: 10,
  ac: 12,
  speed: 30,
  size: 'medium',
});

function dir(files: Record<string, unknown>): string {
  const d = mkdtempSync(join(tmpdir(), 'cat-'));
  for (const [f, v] of Object.entries(files))
    writeFileSync(join(d, f), JSON.stringify(v));
  return d;
}

describe('catalog loader', () => {
  test('loads and looks up by id and kind', () => {
    const c = loadCatalog(
      dir({ 'a.json': [spell('fire_bolt', 0), monster('goblin', 0.25)] }),
    );
    expect(c.get('spell', 'fire_bolt')?.level).toBe(0);
    expect(c.get('monster', 'goblin')?.cr).toBe(0.25);
    expect(c.get('spell', 'goblin')).toBeUndefined();
    expect(c.getAny('nope')).toBeUndefined();
  });

  test('schema-invalid entry reports file and id', () => {
    const bad = { ...spell('bad_spell', 1), school: '' };
    expect(() => loadCatalog(dir({ 'spells.json': [bad] }))).toThrow(
      /spells\.json: bad_spell: school/,
    );
  });

  test('duplicate ids across files are rejected', () => {
    const d = dir({ 'a.json': [spell('x', 1)], 'b.json': [spell('x', 2)] });
    expect(() => loadCatalog(d)).toThrow(/b\.json: x: duplicate id.*a\.json/);
  });

  test('catalogVersion is stable and changes with content', () => {
    const e = [spell('a', 1), monster('m', 1)];
    const v1 = loadCatalog(dir({ 'a.json': e })).catalogVersion;
    expect(loadCatalog(dir({ 'a.json': e })).catalogVersion).toBe(v1);
    // order/file split does not matter
    expect(
      loadCatalog(dir({ 'x.json': [e[1]], 'y.json': [e[0]] })).catalogVersion,
    ).toBe(v1);
    const changed = [spell('a', 2), e[1]];
    expect(loadCatalog(dir({ 'a.json': changed })).catalogVersion).not.toBe(v1);
  });

  test('scope gate: spell level 4 and CR 6 fail, level 3 and CR 5 load', () => {
    expect(() => loadCatalog(dir({ 's.json': [spell('big', 4)] }))).toThrow(
      /s\.json: big: spell level 4/,
    );
    expect(() => loadCatalog(dir({ 'm.json': [monster('ogre', 6)] }))).toThrow(
      /m\.json: ogre: monster CR 6/,
    );
    expect(() =>
      loadCatalog(dir({ 'o.json': [spell('fb', 3), monster('m5', 5)] })),
    ).not.toThrow();
  });
});
