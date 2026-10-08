import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import type { Ability } from '@game/schema';
import { loadCatalog } from '../src/catalog-node.js';
import {
  levelForXp,
  XP_THRESHOLDS,
  awardXp,
  levelUp,
} from '../src/character/levelup.js';
import { longRest, shortRest } from '../src/character/rest.js';
import type { CharacterInput } from '../src/character/types.js';
import { seedRng } from '../src/rng.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../catalog');
const catalog = loadCatalog(root);
function character(): CharacterInput {
  const klass = catalog.get('class', 'class:wizard')!;
  const abilities: Record<Ability, number> = {
    str: 8,
    dex: 14,
    con: 13,
    int: 15,
    wis: 10,
    cha: 15,
  };
  return {
    id: 'rest-test',
    name: 'Rest Test',
    speciesId: 'species:human',
    classId: klass.id,
    backgroundId: 'background:sage',
    level: 1,
    abilities,
    abilityGeneration: {
      method: 'standard-array',
      baseAbilities: { str: 8, dex: 14, con: 12, int: 13, wis: 10, cha: 15 },
      asi: [
        { ability: 'int', amount: 2 },
        { ability: 'con', amount: 1 },
      ],
    },
    proficiencies: {
      skills: [],
      saves: [...klass.saveProficiencies],
      tools: [],
    },
    equipment: [],
    spellsKnown: [],
    spellsPrepared: [],
    slots: { '1': { max: 2, used: 2 } },
    hp: { current: 1, max: 8, temp: 3 },
    conditions: [],
    hitDiceSpent: 0,
  };
}

describe('rests and level advancement', () => {
  test('short rest rolls and spends hit dice with a labelled Constitution modifier', () => {
    const original = character();
    const result = shortRest(original, catalog, seedRng(123), 1);
    expect(result.rolls).toHaveLength(1);
    expect(result.rolls[0]!.dice).toHaveLength(1);
    expect(result.rolls[0]!.modifiers).toContainEqual({
      label: 'Constitution',
      value: 1,
    });
    expect(result.character.hp.current).toBe(
      Math.min(original.hp.max, 1 + result.rolls[0]!.total),
    );
    expect(result.character.hitDiceSpent).toBe(1);
    expect(original.hitDiceSpent).toBe(0);
    expect(() => shortRest(result.character, catalog, result.rng, 1)).toThrow(
      /Hit Dice/,
    );
  });

  test('long rest restores HP and spell slots while recovering spent hit dice', () => {
    const c = {
      ...character(),
      level: 2,
      hp: { current: 1, max: 12, temp: 4 },
      hitDiceSpent: 2,
      slots: { '1': { max: 3, used: 2 } },
    };
    const rested = longRest(c, catalog);
    expect(rested.hp).toEqual({ current: 12, max: 12, temp: 0 });
    expect(rested.slots['1']).toEqual({ max: 3, used: 0 });
    expect(rested.hitDiceSpent).toBe(1);
  });

  test('XP thresholds for levels 2-5 match the SRD cumulative table', () => {
    expect(XP_THRESHOLDS).toEqual({ 2: 300, 3: 900, 4: 2700, 5: 6500 });
    expect(
      [299, 300, 899, 900, 2699, 2700, 6499, 6500].map(levelForXp),
    ).toEqual([1, 2, 2, 3, 3, 4, 4, 5]);
    expect(awardXp({ ...character(), xp: 290 }, 10).xp).toBe(300);
  });

  test('level-up rejects illegal subclass and ASI choices with violation codes', () => {
    const atSubclassLevel = { ...character(), level: 2 };
    const badSubclass = levelUp(
      atSubclassLevel,
      { subclassId: 'subclass:path-of-the-berserker' },
      catalog,
    );
    expect(badSubclass.ok).toBe(false);
    if (!badSubclass.ok)
      expect(badSubclass.violations.map((v) => v.code)).toContain(
        'ILLEGAL_SUBCLASS',
      );
    const atAsiLevel = { ...character(), level: 3 };
    const badAsi = levelUp(
      atAsiLevel,
      { asi: [{ ability: 'int', amount: 3 }] },
      catalog,
    );
    expect(badAsi.ok).toBe(false);
    if (!badAsi.ok)
      expect(badAsi.violations.map((v) => v.code)).toContain('ASI_NOT_ALLOWED');
  });

  test('accepts the right subclass and advances derived HP and spell slots', () => {
    const c = {
      ...character(),
      classId: 'class:wizard',
      level: 2,
      hp: { current: 10, max: 10, temp: 0 },
      slots: { '1': { max: 3, used: 1 } },
    };
    const result = levelUp(c, { subclassId: 'subclass:evoker' }, catalog);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (result.ok) {
      expect(result.character.level).toBe(3);
      expect(result.character.subclassId).toBe('subclass:evoker');
      expect(result.character.hp.max).toBeGreaterThan(c.hp.max);
      expect(result.character.slots['2']?.max).toBe(2);
    }
  });
});
