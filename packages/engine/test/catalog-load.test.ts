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
      dir({
        'a.json': [
          spell('spell:fire-bolt', 0),
          monster('monster:goblin', 0.25),
        ],
      }),
    );
    expect(c.get('spell', 'spell:fire-bolt')?.level).toBe(0);
    expect(c.get('monster', 'monster:goblin')?.cr).toBe(0.25);
    expect(c.get('spell', 'monster:goblin')).toBeUndefined();
    expect(c.getAny('nope')).toBeUndefined();
  });

  test('schema-invalid entry reports file and id', () => {
    const bad = { ...spell('spell:bad-spell', 1), school: '' };
    expect(() => loadCatalog(dir({ 'spells.json': [bad] }))).toThrow(
      /spells\.json: spell:bad-spell: school/,
    );
  });

  test('duplicate ids across files are rejected', () => {
    const d = dir({
      'a.json': [spell('spell:x', 1)],
      'b.json': [spell('spell:x', 2)],
    });
    expect(() => loadCatalog(d)).toThrow(
      /b\.json: spell:x: duplicate id.*a\.json/,
    );
  });

  test('catalogVersion is stable and changes with content', () => {
    const e = [spell('spell:a', 1), monster('monster:m', 1)];
    const v1 = loadCatalog(dir({ 'a.json': e })).catalogVersion;
    expect(loadCatalog(dir({ 'a.json': e })).catalogVersion).toBe(v1);
    // order/file split does not matter
    expect(
      loadCatalog(dir({ 'x.json': [e[1]], 'y.json': [e[0]] })).catalogVersion,
    ).toBe(v1);
    const changed = [spell('spell:a', 2), e[1]];
    expect(loadCatalog(dir({ 'a.json': changed })).catalogVersion).not.toBe(v1);
  });

  test('unresolved condition references are rejected', () => {
    const species = {
      ...base,
      id: 'species:human',
      kind: 'species',
      name: 'Human',
      size: 'medium',
      speed: 30,
      conditionRefs: ['condition:missing'],
    };
    expect(() => loadCatalog(dir({ 'species.json': [species] }))).toThrow(
      /unresolved reference condition:missing/,
    );
  });

  test('subclasses must reference an existing class', () => {
    const subclass = {
      ...base,
      id: 'subclass:champion',
      kind: 'subclass',
      name: 'Champion',
      classId: 'class:missing',
      features: [],
    };
    expect(() => loadCatalog(dir({ 'subclasses.json': [subclass] }))).toThrow(
      /unresolved reference class:missing/,
    );
  });

  test('rejects catalog files above the size limit', () => {
    const d = mkdtempSync(join(tmpdir(), 'cat-'));
    writeFileSync(join(d, 'huge.json'), ' '.repeat(1_048_577));
    expect(() => loadCatalog(d)).toThrow(/file exceeds 1048576 byte limit/);
  });

  test('scope gate: spell level 4 and CR 6 fail, level 3 and CR 5 load', () => {
    expect(() =>
      loadCatalog(dir({ 's.json': [spell('spell:big', 4)] })),
    ).toThrow(/s\.json: spell:big: spell level 4/);
    expect(() =>
      loadCatalog(dir({ 'm.json': [monster('monster:ogre', 6)] })),
    ).toThrow(/m\.json: monster:ogre: monster CR 6/);
    expect(() =>
      loadCatalog(
        dir({ 'o.json': [spell('spell:fb', 3), monster('monster:m5', 5)] }),
      ),
    ).not.toThrow();
  });
});
