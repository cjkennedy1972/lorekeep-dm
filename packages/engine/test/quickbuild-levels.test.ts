import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { loadCatalog } from '../src/catalog-node.js';
import { quickBuild } from '../src/character/builder.js';
import { levelUp } from '../src/character/levelup.js';
import { validateCharacter } from '../src/character/validate.js';
import type {
  CharacterInput,
  RuleViolationCode,
} from '../src/character/types.js';

const catalog = loadCatalog(
  resolve(dirname(fileURLToPath(import.meta.url)), '../catalog'),
);
const classes = catalog.entries.filter((entry) => entry.kind === 'class');
const classIds = classes.map((entry) => entry.id);

describe('quick builds for levels 1-5', () => {
  test('all 12 classes build legally at each level across multiple seeds', () => {
    expect(classIds).toHaveLength(12);
    for (const classId of classIds)
      for (let level = 1; level <= 5; level += 1)
        for (const seed of [7, 2901]) {
          const { character } = quickBuild(catalog, classId, seed, level);
          expect(character.level).toBe(level);
          expect(validateCharacter(character, catalog)).toEqual([]);
        }
  });

  test('quick level-5 build matches level-up progression for same choices', () => {
    for (const klass of classes) {
      const quick = quickBuild(catalog, klass.id, 418, 5).character;
      let advanced = quickBuild(catalog, klass.id, 418, 1).character;
      for (let level = 2; level <= 5; level += 1) {
        const featureAtLevel = (pattern: RegExp) =>
          (klass.features ?? []).some(
            (feature) => feature.level === level && pattern.test(feature.name),
          );
        const subclass = featureAtLevel(/subclass/i)
          ? catalog.entries.find(
              (entry) =>
                entry.kind === 'subclass' && entry.classId === klass.id,
            )
          : undefined;
        const asi = featureAtLevel(/ability score improvement/i)
          ? [{ ability: klass.primaryAbility[0]!, amount: 2 as const }]
          : [];
        const knownCount =
          klass.cantripsKnown?.[level - 1] ?? advanced.spellsKnown.length;
        const preparedCount =
          klass.preparedSpells?.[level - 1] ?? advanced.spellsPrepared.length;
        const spells = catalog.entries.filter(
          (entry) =>
            entry.kind === 'spell' &&
            entry.classes.includes(klass.name.toLowerCase()),
        );
        const spellsKnown = spells
          .filter((spell) => spell.kind === 'spell' && spell.level === 0)
          .slice(advanced.spellsKnown.length, knownCount)
          .map((spell) => spell.id);
        const spellsPrepared = spells
          .filter((spell) => spell.kind === 'spell' && spell.level > 0)
          .slice(advanced.spellsPrepared.length, preparedCount)
          .map((spell) => spell.id);
        const result = levelUp(
          advanced,
          {
            ...(subclass?.kind === 'subclass'
              ? { subclassId: subclass.id }
              : {}),
            asi,
            spellsKnown,
            spellsPrepared,
          },
          catalog,
        );
        expect(
          result.ok,
          `${klass.name} level ${level}: ${JSON.stringify(result)}`,
        ).toBe(true);
        if (!result.ok) throw new Error('Expected legal level-up');
        advanced = result.character;
      }
      expect(quick).toEqual(advanced);
    }
  });

  test.each([
    [
      'bad ASI',
      (c: CharacterInput) => ({
        ...c,
        abilities: { ...c.abilities, str: c.abilities.str + 2 },
      }),
      'ASI_NOT_ALLOWED',
    ],
    [
      'over-prepared spells',
      (c: CharacterInput) => ({
        ...c,
        spellsPrepared: [...c.spellsPrepared, ...c.spellsPrepared],
      }),
      'TOO_MANY_SPELLS',
    ],
    [
      'wrong slots',
      (c: CharacterInput) => ({ ...c, slots: {} }),
      'WRONG_SPELL_SLOTS',
    ],
    [
      'missing subclass',
      (c: CharacterInput) => ({ ...c, subclassId: undefined }),
      'MISSING_SUBCLASS',
    ],
    [
      'wrong HP',
      (c: CharacterInput) => ({ ...c, hp: { ...c.hp, max: c.hp.max + 1 } }),
      'HP_MISMATCH',
    ],
  ] as [
    string,
    (character: CharacterInput) => CharacterInput,
    RuleViolationCode,
  ][])('%s is rejected with its violation code', (_name, mutate, code) => {
    const character = quickBuild(catalog, 'class:wizard', 29, 4).character;
    const violations = validateCharacter(mutate(character), catalog);
    expect(violations.map((violation) => violation.code)).toContain(code);
  });

  test('rejects levels outside the supported range', () => {
    expect(() => quickBuild(catalog, 'class:fighter', 1, 0)).toThrow(
      RangeError,
    );
    expect(() => quickBuild(catalog, 'class:fighter', 1, 6)).toThrow(
      RangeError,
    );
  });
});
