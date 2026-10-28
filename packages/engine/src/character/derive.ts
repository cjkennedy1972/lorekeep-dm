import type { Ability } from '@game/schema';
import type { CharacterInput, CharacterCatalog } from './types.js';

const SKILL_ABILITY: Record<string, Ability> = {
  acrobatics: 'dex',
  'animal-handling': 'wis',
  arcana: 'int',
  athletics: 'str',
  deception: 'cha',
  history: 'int',
  insight: 'wis',
  intimidation: 'cha',
  investigation: 'int',
  medicine: 'wis',
  nature: 'int',
  perception: 'wis',
  performance: 'cha',
  persuasion: 'cha',
  religion: 'int',
  'sleight-of-hand': 'dex',
  stealth: 'dex',
  survival: 'wis',
};
const ARMOR_CLASS: Record<string, { base: number; maxDex?: number }> = {
  breastplate: { base: 14, maxDex: 2 },
  'chain mail': { base: 16, maxDex: 0 },
  'chain shirt': { base: 13, maxDex: 2 },
  'half plate armor': { base: 15, maxDex: 2 },
  'hide armor': { base: 12, maxDex: 2 },
  'leather armor': { base: 11 },
  'padded armor': { base: 11 },
  'plate armor': { base: 18, maxDex: 0 },
  'ring mail': { base: 14, maxDex: 0 },
  'scale mail': { base: 14, maxDex: 2 },
  'splint armor': { base: 17, maxDex: 0 },
  'studded leather armor': { base: 12 },
};
const mod = (score: number) => Math.floor((score - 10) / 2);
const proficiencyBonus = (level: number) => 2 + Math.floor((level - 1) / 4);
export interface DerivedSheet {
  ac: number;
  maxHp: number;
  initiative: number;
  saves: Record<Ability, number>;
  skillBonuses: Record<string, number>;
  attackBonuses: Record<string, number>;
  spellDc?: number;
  spellSlots: Record<string, number>;
}

export function deriveSheet(
  char: CharacterInput,
  catalog: CharacterCatalog,
): DerivedSheet {
  const klass = catalog.get('class', char.classId);
  const prof = proficiencyBonus(char.level);
  const saves = Object.fromEntries(
    (['str', 'dex', 'con', 'int', 'wis', 'cha'] as Ability[]).map((a) => [
      a,
      mod(char.abilities[a]) +
        (char.proficiencies.saves.includes(a) ? prof : 0),
    ]),
  ) as Record<Ability, number>;
  const skillBonuses = Object.fromEntries(
    Object.entries(SKILL_ABILITY).map(([skill, ability]) => [
      skill,
      mod(char.abilities[ability]) +
        (char.proficiencies.skills.includes(skill) ? prof : 0),
    ]),
  );
  const equipped = char.equipment
    .filter((item) => item.equipped && item.qty > 0)
    .map((item) => ({
      item,
      entry: catalog.get('equipment', item.itemId),
    }));
  const bodyArmor = equipped.find(
    ({ entry }) =>
      entry?.category === 'armor' && entry.name.toLowerCase() !== 'shield',
  );
  const armor = bodyArmor
    ? ARMOR_CLASS[bodyArmor.entry!.name.toLowerCase()]
    : undefined;
  const shieldEquipped = equipped.some(
    ({ entry }) =>
      entry?.category === 'armor' && entry.name.toLowerCase() === 'shield',
  );
  const unarmoredDefenseAbility =
    klass?.id === 'class:barbarian'
      ? 'con'
      : klass?.id === 'class:monk' && !shieldEquipped
        ? 'wis'
        : undefined;
  const ac = armor
    ? armor.base + Math.min(mod(char.abilities.dex), armor.maxDex ?? Infinity)
    : 10 +
      mod(char.abilities.dex) +
      (!bodyArmor && unarmoredDefenseAbility
        ? mod(char.abilities[unarmoredDefenseAbility])
        : 0);
  const shieldBonus = shieldEquipped ? 2 : 0;
  const attackBonuses = Object.fromEntries(
    equipped
      .filter(({ entry }) => entry?.category === 'weapon')
      .map(({ item }) => [item.itemId, mod(char.abilities.str) + prof]),
  );
  const spellSlots: Record<string, number> = {};
  for (const [i, count] of (
    klass?.spellSlots?.[char.level - 1] ?? []
  ).entries())
    if (count) spellSlots[String(i + 1)] = count;
  const spellAbility = klass?.spellcastingAbility;
  return {
    ac: ac + shieldBonus,
    maxHp: klass
      ? klass.hitDie +
        mod(char.abilities.con) +
        (char.level - 1) *
          (Math.floor(klass.hitDie / 2) + 1 + mod(char.abilities.con))
      : char.hp.max,
    initiative: mod(char.abilities.dex),
    saves,
    skillBonuses,
    attackBonuses,
    ...(spellAbility
      ? { spellDc: 8 + prof + mod(char.abilities[spellAbility]) }
      : {}),
    spellSlots,
  };
}
