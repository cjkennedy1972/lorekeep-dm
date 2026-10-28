import type { CharacterInput } from '@game/rules-engine';
import { loadCatalog } from '@game/rules-engine/room-tools';
import { describe, expect, it } from 'vitest';
import { attacksFor } from '../../src/room/combatBootstrap.js';
import { quickBuild } from '@game/rules-engine';

const catalog = loadCatalog();
const place = { pos: { x: 0, y: 0 }, size: 1, hp: 10, maxHp: 10, ac: 10 };

describe('saving throw bonuses on combat entities', () => {
  it('gives a PC its derived saves, with proficiency where it has one', () => {
    const character = {
      id: 'ent_pc',
      level: 1,
      abilities: { str: 10, dex: 10, con: 14, int: 10, wis: 10, cha: 10 },
      proficiencies: { skills: [], saves: ['con'], tools: [] },
      equipment: [],
      hp: { max: 10, current: 10 },
      slots: {},
      spellsKnown: [],
      spellsPrepared: [],
    } as unknown as CharacterInput;
    const { saves } = attacksFor(
      { id: 'ent_pc', team: 'party', speed: 30, ...place },
      character,
      {},
      catalog,
    );
    expect(saves).toMatchObject({ str: 0, dex: 0, con: 4 });
  });

  it('gives a monster its catalog save bonuses', () => {
    const { saves } = attacksFor(
      {
        id: 'ent_brass-dragon-wyrmling_1',
        team: 'dragons',
        speed: 30,
        ...place,
      },
      undefined,
      {},
      catalog,
    );
    expect(saves).toEqual({ dex: 2, wis: 2 });
  });

  it('falls back to the ability modifier when the catalog omits that save', () => {
    const monster = catalog.get('monster', 'monster:brass-dragon-wyrmling')!;
    const altered = { ...monster, saves: { wis: 2 } };
    const noDexCatalog = {
      ...catalog,
      get: (kind: string, id: string) =>
        kind === 'monster' && id === altered.id
          ? altered
          : catalog.get(kind as never, id),
    };
    const { saves, abilities } = attacksFor(
      {
        id: 'ent_brass-dragon-wyrmling_1',
        team: 'dragons',
        speed: 30,
        ...place,
      },
      undefined,
      {},
      noDexCatalog,
    );
    expect(saves?.dex).toBeUndefined();
    expect(abilities?.dex).toBe(10);
  });
});

describe('starting-gear combat attacks', () => {
  it.each([
    ['class:cleric', 'equipment:mace', 'Mace', '1d6-1', 'bludgeoning', 1],
    [
      'class:fighter',
      'equipment:longsword',
      'Longsword',
      '1d8+2',
      'slashing',
      4,
    ],
  ])(
    '%s offers its starting weapon attack',
    (classId, itemId, name, damage, damageType, attackBonus) => {
      const character = quickBuild(catalog, classId, 0x28, 1).character;
      const weaponCharacter = {
        ...character,
        equipment: [{ itemId, qty: 1, equipped: true }],
      };
      const { attacks } = attacksFor(
        { id: weaponCharacter.id, team: 'party', speed: 30, ...place },
        weaponCharacter,
        {},
        catalog,
      );
      expect(attacks).toContainEqual(
        expect.objectContaining({
          id: itemId,
          name,
          attackBonus,
          damage,
          damageType,
        }),
      );
    },
  );
});

describe('weapon attack abilities', () => {
  const character = quickBuild(catalog, 'class:fighter', 0x28, 1).character;

  it.each([
    ['equipment:rapier', 'Rapier', 10, 16, 5, '1d8+3'],
    ['equipment:rapier', 'Rapier', 14, 12, 4, '1d8+2'],
    ['equipment:shortbow', 'Shortbow', 10, 16, 5, '1d6+3'],
    ['equipment:longbow', 'Longbow', 10, 16, 5, '1d8+3'],
    ['equipment:spear', 'Spear', 10, 16, 2, '1d6'],
    ['equipment:handaxe', 'Handaxe', 10, 16, 2, '1d6'],
    ['equipment:light-hammer', 'Light Hammer', 10, 16, 2, '1d4'],
    ['equipment:javelin', 'Javelin', 10, 16, 2, '1d6'],
    ['equipment:trident', 'Trident', 10, 16, 2, '1d8'],
  ])(
    '%s uses the correct ability for its attack and damage',
    (itemId, name, str, dex, attackBonus, damage) => {
      const equipped = {
        ...character,
        abilities: { ...character.abilities, str, dex },
        equipment: [{ itemId, qty: 1, equipped: true }],
      };
      const { attacks } = attacksFor(
        { id: equipped.id, team: 'party', speed: 30, ...place },
        equipped,
        {},
        catalog,
      );
      expect(attacks).toContainEqual(
        expect.objectContaining({ id: itemId, name, attackBonus, damage }),
      );
    },
  );

  it.each([
    [10, 16, 5, '1d4+3'],
    [16, 10, 5, '1d4+3'],
  ])(
    'uses the higher Strength or Dexterity modifier for a finesse dagger',
    (str, dex, attackBonus, damage) => {
      const equipped = {
        ...character,
        abilities: { ...character.abilities, str, dex },
        equipment: [{ itemId: 'equipment:dagger', qty: 1, equipped: true }],
      };
      const { attacks } = attacksFor(
        { id: equipped.id, team: 'party', speed: 30, ...place },
        equipped,
        {},
        catalog,
      );
      expect(attacks).toContainEqual(
        expect.objectContaining({
          id: 'equipment:dagger',
          name: 'Dagger',
          attackBonus,
          damage,
          damageType: 'piercing',
        }),
      );
    },
  );

  it('does not offer an unequipped weapon', () => {
    const unequipped = {
      ...character,
      equipment: [{ itemId: 'equipment:longsword', qty: 1, equipped: false }],
    };
    const { attacks } = attacksFor(
      { id: unequipped.id, team: 'party', speed: 30, ...place },
      unequipped,
      {},
      catalog,
    );
    expect(attacks).toEqual([expect.objectContaining({ id: 'unarmed' })]);
  });

  it('offers an unarmed strike when the character has no weapon', () => {
    const unarmedCharacter = { ...character, equipment: [] };
    const { attacks } = attacksFor(
      { id: unarmedCharacter.id, team: 'party', speed: 30, ...place },
      unarmedCharacter,
      {},
      catalog,
    );
    expect(attacks).toEqual([
      expect.objectContaining({
        id: 'unarmed',
        name: 'Unarmed strike',
        attackBonus: 4,
        damage: '1d1+2',
        damageType: 'bludgeoning',
      }),
    ]);
  });
});
