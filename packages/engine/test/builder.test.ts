import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { loadCatalog } from '../src/catalog-node.js';
import { CharacterBuilder, quickBuild } from '../src/character/builder.js';
import { deriveSheet } from '../src/character/derive.js';
import { validateCharacter } from '../src/character/validate.js';

const catalog = loadCatalog(
  resolve(dirname(fileURLToPath(import.meta.url)), '../catalog'),
);
const classIds = catalog.entries
  .filter((e) => e.kind === 'class')
  .map((e) => e.id);

describe('quickBuild', () => {
  test('covers 12 classes', () => expect(classIds).toHaveLength(12));
  test.each(classIds)('%s builds with zero violations', (id) => {
    for (const seed of [0, 1, 42, 4294967295]) {
      const { character, choices } = quickBuild(catalog, id, seed);
      expect(validateCharacter(character, catalog)).toEqual([]);
      expect(character.classId).toBe(id);
      expect(character.level).toBe(1);
      expect(character.hp.max).toBeGreaterThan(0);
      for (const c of choices) expect(c.explanation.trim()).not.toBe('');
    }
  });
  test.each(classIds)(
    '%s equips one sensible starting weapon and armor loadout',
    (id) => {
      const { character } = quickBuild(catalog, id, 0x28);
      const weapons = character.equipment.filter(
        (item) =>
          item.equipped &&
          catalog.get('equipment', item.itemId)?.category === 'weapon',
      );
      expect(weapons).toHaveLength(1);
      expect(weapons[0]!.qty).toBe(1);
      const sheet = deriveSheet(character, catalog);
      expect(Object.keys(sheet.attackBonuses)).toEqual([weapons[0]!.itemId]);
      const rangedWeaponNames = new Set([
        'javelin',
        'dart',
        'longbow',
        'shortbow',
        'sling',
        'light crossbow',
        'heavy crossbow',
        'hand crossbow',
        'blowgun',
        'musket',
        'pistol',
      ]);
      const ownsMeleeWeapon = character.equipment.some((item) => {
        const entry = catalog.get('equipment', item.itemId);
        return (
          entry?.category === 'weapon' &&
          !rangedWeaponNames.has(entry.name.toLowerCase())
        );
      });
      if (ownsMeleeWeapon)
        expect(
          character.equipment
            .filter((item) => {
              const entry = catalog.get('equipment', item.itemId);
              return (
                entry?.category === 'weapon' &&
                rangedWeaponNames.has(entry.name.toLowerCase())
              );
            })
            .every((item) => !item.equipped),
        ).toBe(true);

      const bodyArmor = character.equipment.filter(
        (item) =>
          item.equipped &&
          catalog.get('equipment', item.itemId)?.category === 'armor' &&
          item.itemId !== 'equipment:shield',
      );
      expect(bodyArmor).toHaveLength(
        character.equipment.some(
          (item) =>
            catalog.get('equipment', item.itemId)?.category === 'armor' &&
            item.itemId !== 'equipment:shield',
        )
          ? 1
          : 0,
      );
      const equippedArmor = character.equipment.filter(
        (item) =>
          item.equipped &&
          catalog.get('equipment', item.itemId)?.category === 'armor',
      );
      const dex = Math.floor((character.abilities.dex - 10) / 2);
      const armorStats: Record<string, { base: number; maxDex?: number }> = {
        'equipment:chain-mail': { base: 16, maxDex: 0 },
        'equipment:chain-shirt': { base: 13, maxDex: 2 },
        'equipment:leather-armor': { base: 11 },
        'equipment:studded-leather-armor': { base: 12 },
      };
      const wornBodyArmor = bodyArmor[0];
      const expectedBase = wornBodyArmor
        ? armorStats[wornBodyArmor.itemId]!.base +
          Math.min(dex, armorStats[wornBodyArmor.itemId]!.maxDex ?? Infinity)
        : 10 +
          dex +
          (id === 'class:barbarian'
            ? Math.floor((character.abilities.con - 10) / 2)
            : id === 'class:monk'
              ? Math.floor((character.abilities.wis - 10) / 2)
              : 0);
      const shieldBonus = equippedArmor.some(
        (item) => item.itemId === 'equipment:shield',
      )
        ? 2
        : 0;
      expect(sheet.ac).toBe(expectedBase + shieldBonus);
    },
  );
  test('is deterministic and seed-sensitive; classId optional', () => {
    expect(quickBuild(catalog, undefined, 7)).toEqual(
      quickBuild(catalog, undefined, 7),
    );
    const ids = new Set(
      Array.from(
        { length: 20 },
        (_, i) => quickBuild(catalog, undefined, i).character.classId,
      ),
    );
    expect(ids.size).toBeGreaterThan(1);
  });
  test('rejects unknown class', () =>
    expect(() => quickBuild(catalog, 'class:nope', 1)).toThrow());
  test.each(['class:fighter', 'class:wizard'])(
    '%s starts with resolved equipment',
    (id) => {
      const character = quickBuild(catalog, id, 0x28).character;
      expect(character.equipment.length).toBeGreaterThan(0);
      expect(
        character.equipment.every((item) =>
          catalog.get('equipment', item.itemId),
        ),
      ).toBe(true);
    },
  );
});

describe('CharacterBuilder', () => {
  test('every exposed option has a non-empty explanation', () => {
    const b = new CharacterBuilder(catalog)
      .setClass('class:wizard')
      .setBackground('background:sage');
    const all = [
      ...b.classOptions(),
      ...b.backgroundOptions(),
      ...b.speciesOptions(),
      ...b.abilityMethodOptions(),
      ...b.skillOptions(),
      ...b.equipmentOptions(),
    ];
    expect(all.length).toBeGreaterThan(20);
    for (const o of all) expect(o.explanation.trim()).not.toBe('');
  });
  test('illegal ids throw at every step', () => {
    const b = new CharacterBuilder(catalog);
    expect(() => b.setClass('class:nope')).toThrow();
    expect(() => b.setBackground('species:human')).toThrow();
    expect(() => b.setSpecies('class:wizard')).toThrow();
    expect(() => b.setAbilityMethod('manual')).toThrow();
    b.setClass('class:wizard').setBackground('background:sage');
    expect(() => b.setSkills(['athletics', 'history'])).toThrow(); // not a wizard skill / background overlap
    expect(() => b.setSkills(['arcana', 'insight'])).toThrow(); // arcana is the background's
    expect(() => b.setSkills(['insight'])).toThrow(); // wrong count
    expect(() => b.setEquipment('Z')).toThrow();
    expect(() => b.setName('  ')).toThrow();
    expect(() => b.build()).toThrow();
  });
  test('step-wise build works and lists only legal options', () => {
    const b = new CharacterBuilder(catalog)
      .setClass('class:fighter')
      .setBackground('background:soldier')
      .setSpecies('species:human')
      .setAbilityMethod('point-buy');
    const skills = b.skillOptions().map((o) => o.id);
    expect(skills).not.toContain('athletics');
    const eq = b.equipmentOptions();
    b.setSkills(skills.slice(0, 2)).setEquipment(eq[0]!.id).setName('Bran');
    const c = b.build();
    expect(c.name).toBe('Bran');
    expect(validateCharacter(c, catalog)).toEqual([]);
  });
});
