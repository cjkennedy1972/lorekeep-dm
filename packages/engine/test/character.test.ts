import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import type { Ability } from '@game/schema';
import { loadCatalog } from '../src/catalog-node.js';
import { deriveSheet } from '../src/character/derive.js';
import { validateCharacter } from '../src/character/validate.js';
import type { CharacterInput } from '../src/character/types.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../catalog');
const catalog = loadCatalog(root);
const abilities: Record<Ability, number> = {
  str: 15,
  dex: 14,
  con: 13,
  int: 12,
  wis: 10,
  cha: 8,
};
function character(seed = 0): CharacterInput {
  const classes = catalog.entries.filter((e) => e.kind === 'class');
  const klass = classes[seed % classes.length]!;
  const bg = catalog.get('background', 'background:soldier')!;
  return {
    id: `character-${seed}`,
    name: 'Test',
    speciesId: 'species:human',
    classId: klass.id,
    backgroundId: bg.id,
    level: 1,
    abilities: { ...abilities },
    abilityGeneration: {
      method: 'standard-array',
      baseAbilities: { ...abilities },
    },
    proficiencies: {
      skills: ['athletics', 'intimidation'],
      saves: [...klass.saveProficiencies],
      tools: [],
    },
    equipment: [],
    spellsKnown: [],
    spellsPrepared: [],
    slots: Object.fromEntries(
      Object.entries(
        deriveSheet(
          {
            level: 1,
            classId: klass.id,
            abilities,
            proficiencies: {
              saves: [...klass.saveProficiencies],
              skills: [],
              tools: [],
            },
            equipment: [],
            spellsKnown: [],
            spellsPrepared: [],
            slots: {},
            hp: { current: 0, max: 0, temp: 0 },
          } as CharacterInput,
          catalog,
        ).spellSlots,
      ).map(([level, max]) => [level, { max, used: 0 }]),
    ),
    hp: {
      current: 0,
      max: deriveSheet(
        {
          level: 1,
          classId: klass.id,
          abilities,
          proficiencies: {
            saves: [...klass.saveProficiencies],
            skills: [],
            tools: [],
          },
          equipment: [],
          spellsKnown: [],
          spellsPrepared: [],
          slots: {},
          hp: { current: 0, max: 0, temp: 0 },
        } as CharacterInput,
        catalog,
      ).maxHp,
      temp: 0,
    },
    conditions: [],
  };
}
const codes = (c: CharacterInput) =>
  validateCharacter(c, catalog).map((v) => v.code);

describe('character validator', () => {
  test('reports specific codes for required illegal cases', () => {
    const pointBuy = character();
    pointBuy.abilityGeneration = {
      method: 'point-buy',
      baseAbilities: { str: 15, dex: 15, con: 15, int: 9, wis: 8, cha: 8 },
    };
    expect(codes(pointBuy)).toContain('POINT_BUY_TOTAL');
    const asi = character();
    asi.abilityGeneration!.asi = [{ ability: 'wis', amount: 2 }];
    expect(codes(asi)).toContain('ASI_NOT_ALLOWED');
    const skills = character();
    skills.proficiencies.skills = ['athletics', 'intimidation', 'perception'];
    skills.backgroundSkills = ['athletics', 'intimidation', 'perception'];
    expect(codes(skills)).toContain('BACKGROUND_SKILL_COUNT');
    const spell = character();
    spell.classId = 'class:barbarian';
    spell.spellsKnown = ['spell:fireball'];
    expect(codes(spell)).toContain('SPELL_NOT_ON_CLASS_LIST');
  });

  test('legal-builder outputs validate across 200 deterministic seeds', () => {
    const legalBuilder = (seed: number): CharacterInput => {
      const c = character(seed);
      c.proficiencies.skills = ['athletics', 'intimidation'];
      c.abilityGeneration!.baseAbilities = { ...c.abilities };
      return c;
    };
    for (let seed = 0; seed < 200; seed++) {
      const c = legalBuilder(seed);
      const klass = catalog.get('class', c.classId)!;
      const derivedSlots = deriveSheet(c, catalog).spellSlots;
      const pact = klass.pactMagic?.[0];
      c.slots = pact
        ? { [String(pact.slotLevel)]: { max: pact.slots, used: 0 } }
        : Object.fromEntries(
            Object.entries(derivedSlots).map(([level, max]) => [
              level,
              { max, used: 0 },
            ]),
          );
      expect(validateCharacter(c, catalog), `seed ${seed}`).toEqual([]);
    }
  });

  test('pure deterministic output for same input', () => {
    const c = character();
    expect(validateCharacter(c, catalog)).toEqual(
      validateCharacter(c, catalog),
    );
  });

  test('derives five hand-computed reference sheets', () => {
    const refs = [
      {
        level: 1,
        scores: { ...abilities },
        classId: 'class:fighter',
        hp: 11,
        ac: 12,
        init: 2,
        dc: undefined,
        slots: {},
      },
      {
        level: 2,
        scores: { ...abilities, dex: 16, con: 14 },
        classId: 'class:wizard',
        hp: 14,
        ac: 13,
        init: 3,
        dc: 11,
        slots: { '1': 3 },
      },
      {
        level: 3,
        scores: { ...abilities, wis: 16 },
        classId: 'class:cleric',
        hp: 21,
        ac: 12,
        init: 2,
        dc: 13,
        slots: { '1': 4, '2': 2 },
      },
      {
        level: 4,
        scores: { ...abilities, str: 16, con: 14, cha: 10 },
        classId: 'class:paladin',
        hp: 36,
        ac: 12,
        init: 2,
        dc: 10,
        slots: { '1': 3 },
      },
      {
        level: 5,
        scores: { ...abilities, dex: 16, con: 16, cha: 16 },
        classId: 'class:bard',
        hp: 43,
        ac: 13,
        init: 3,
        dc: 14,
        slots: { '1': 4, '2': 3, '3': 2 },
      },
    ];
    for (const [i, ref] of refs.entries()) {
      const c = character(i);
      c.level = ref.level;
      c.abilities = ref.scores;
      c.classId = ref.classId;
      c.proficiencies.saves = catalog.get(
        'class',
        ref.classId,
      )!.saveProficiencies;
      const sheet = deriveSheet(c, catalog);
      expect(sheet.maxHp).toBe(ref.hp);
      expect(sheet.ac).toBe(ref.ac);
      expect(sheet.initiative).toBe(ref.init);
      expect(sheet.spellDc).toBe(ref.dc);
      expect(sheet.spellSlots).toEqual(ref.slots);
      expect(sheet.saves.str).toBe(
        Math.floor((ref.scores.str - 10) / 2) +
          (c.proficiencies.saves.includes('str') ? 2 : 0),
      );
      expect(sheet.skillBonuses.athletics).toBe(
        Math.floor((ref.scores.str - 10) / 2) +
          2 +
          Math.floor((ref.level - 1) / 4),
      );
    }
  });
});
