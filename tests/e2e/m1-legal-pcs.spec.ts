import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  quickBuild,
  validateCharacter,
  type CharacterInput,
} from '@game/rules-engine';
import {
  DEFAULT_CATALOG_DIR,
  catalogVersionOf,
  loadCatalog,
} from '@game/rules-engine/catalog-node';

const catalog = loadCatalog();
const classIds = catalog.entries
  .filter((e) => e.kind === 'class')
  .map((e) => e.id);

describe('M1 exit criterion 3: legal PCs', () => {
  test('catalog has 12 classes', () => expect(classIds).toHaveLength(12));

  test.each(classIds)(
    '%s quick-builds a legal level-1 PC (real validator, several seeds)',
    (id) => {
      for (const seed of [1, 2901, 65535]) {
        const { character } = quickBuild(catalog, id, seed);
        expect(character.classId).toBe(id);
        expect(validateCharacter(character, catalog)).toEqual([]);
      }
    },
  );

  const base = (): CharacterInput =>
    structuredClone(quickBuild(catalog, 'class:wizard', 11).character);
  const fixtures: [string, string, (c: CharacterInput) => void][] = [
    [
      'point-buy over budget',
      'POINT_BUY_TOTAL',
      (c) => {
        c.abilityGeneration = {
          method: 'point-buy',
          baseAbilities: { str: 15, dex: 15, con: 15, int: 9, wis: 8, cha: 8 },
        };
      },
    ],
    [
      'ASI to an ability the background does not offer',
      'ASI_NOT_ALLOWED',
      (c) => {
        c.abilityGeneration = {
          ...c.abilityGeneration!,
          asi: [{ ability: 'cha', amount: 3 }],
        };
      },
    ],
    [
      'three background skills',
      'BACKGROUND_SKILL_COUNT',
      (c) => {
        c.backgroundSkills = ['arcana', 'history', 'insight'];
      },
    ],
    [
      'fireball on a barbarian',
      'SPELL_NOT_ON_CLASS_LIST',
      (c) => {
        c.classId = 'class:barbarian';
        c.spellsKnown = ['spell:fireball'];
      },
    ],
    [
      'unknown class',
      'UNKNOWN_CLASS',
      (c) => {
        c.classId = 'class:artificer-of-doom';
      },
    ],
  ];

  test('baseline fixture is legal', () =>
    expect(validateCharacter(base(), catalog)).toEqual([]));

  test.each(fixtures)('illegal fixture: %s -> %s', (_name, code, mutate) => {
    const c = base();
    mutate(c);
    expect(validateCharacter(c, catalog).map((v) => v.code)).toContain(code);
  });
});

describe('M1 exit criterion 4: catalog scope gate and catalogVersion hash', () => {
  const dirWith = (entries: object[]) => {
    const d = mkdtempSync(join(tmpdir(), 'm1-proof-'));
    writeFileSync(join(d, 'x.json'), JSON.stringify(entries));
    return d;
  };
  const common = {
    catalogVersion: '1',
    srd: { source: 'SRD 5.2.1', ref: 'proof' },
  };
  const spell = (level: number) => ({
    ...common,
    id: `spell:l${level}`,
    kind: 'spell',
    name: 'S',
    level,
    school: 'evocation',
    classes: [],
  });
  const monster = (cr: number) => ({
    ...common,
    id: `monster:cr${cr}`,
    kind: 'monster',
    name: 'M',
    cr,
    hp: 10,
    ac: 12,
    speed: 30,
    size: 'medium',
  });

  test('shipped catalog loads and respects the scope caps', () => {
    for (const e of catalog.entries) {
      if (e.kind === 'spell') expect(e.level).toBeLessThanOrEqual(3);
      if (e.kind === 'monster') expect(e.cr).toBeLessThanOrEqual(5);
    }
  });

  test('loader rejects spell level 4 and CR 6, accepts level 3 and CR 5', () => {
    expect(() => loadCatalog(dirWith([spell(4)]))).toThrow(/spell level 4/);
    expect(() => loadCatalog(dirWith([monster(6)]))).toThrow(/CR 6/);
    expect(() => loadCatalog(dirWith([spell(3), monster(5)]))).not.toThrow();
  });

  test('catalogVersion is a stable sha256, recomputable, and content-sensitive', () => {
    const again = loadCatalog(DEFAULT_CATALOG_DIR);
    expect(catalog.catalogVersion).toMatch(/^[0-9a-f]{64}$/);
    expect(again.catalogVersion).toBe(catalog.catalogVersion);
    expect(catalogVersionOf(catalog.entries)).toBe(catalog.catalogVersion);
    expect(catalogVersionOf([...catalog.entries].reverse())).toBe(
      catalog.catalogVersion,
    );
    const changed = catalog.entries.map((e, i) =>
      i === 0 ? { ...e, name: `${e.name}!` } : e,
    );
    expect(catalogVersionOf(changed)).not.toBe(catalog.catalogVersion);
  });
});
