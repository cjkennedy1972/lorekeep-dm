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
  const attackBonuses = Object.fromEntries(
    char.equipment
      .filter((i) => i.equipped)
      .map((i) => [i.itemId, mod(char.abilities.str) + prof]),
  );
  const spellSlots: Record<string, number> = {};
  for (const [i, count] of (
    klass?.spellSlots?.[char.level - 1] ?? []
  ).entries())
    if (count) spellSlots[String(i + 1)] = count;
  const spellAbility = klass?.spellcastingAbility;
  return {
    ac: 10 + mod(char.abilities.dex),
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
