import type { Ability, CatalogEntry } from '@game/schema';
import type {
  CharacterInput,
  CharacterCatalog,
  RuleViolation,
} from './types.js';

const ABILITIES: Ability[] = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
const COST: Record<number, number> = {
  8: 0,
  9: 1,
  10: 2,
  11: 3,
  12: 4,
  13: 5,
  14: 7,
  15: 9,
};
const STANDARD = [15, 14, 13, 12, 10, 8];
const SKILLS = new Set([
  'acrobatics',
  'animal-handling',
  'arcana',
  'athletics',
  'deception',
  'history',
  'insight',
  'intimidation',
  'investigation',
  'medicine',
  'nature',
  'perception',
  'performance',
  'persuasion',
  'religion',
  'sleight-of-hand',
  'stealth',
  'survival',
]);
const entriesOf = (catalog: CharacterCatalog) => catalog.entries;
const entryBy = <K extends CatalogEntry['kind']>(
  catalog: CharacterCatalog,
  kind: K,
  id: string,
) => catalog.get(kind, id);
const violation = (
  code: RuleViolation['code'],
  path: string,
  message: string,
): RuleViolation => ({ code, path, message });

export function validateCharacter(
  char: CharacterInput,
  catalog: CharacterCatalog,
): RuleViolation[] {
  const out: RuleViolation[] = [];
  const species = entryBy(catalog, 'species', char.speciesId);
  const klass = entryBy(catalog, 'class', char.classId);
  const background = entryBy(catalog, 'background', char.backgroundId);
  if (!species)
    out.push(
      violation(
        'UNKNOWN_SPECIES',
        'speciesId',
        `Unknown species ${char.speciesId}`,
      ),
    );
  if (!klass)
    out.push(
      violation('UNKNOWN_CLASS', 'classId', `Unknown class ${char.classId}`),
    );
  if (!background)
    out.push(
      violation(
        'UNKNOWN_BACKGROUND',
        'backgroundId',
        `Unknown background ${char.backgroundId}`,
      ),
    );

  if (char.abilityGeneration) {
    const gen = char.abilityGeneration;
    if (ABILITIES.some((a) => char.abilities[a] < 1 || char.abilities[a] > 30))
      out.push(
        violation(
          'ABILITY_RANGE',
          'abilities',
          'Ability scores must be in range 1-30',
        ),
      );
    if (gen.method === 'point-buy') {
      const scores = ABILITIES.map((a) => gen.baseAbilities[a]);
      const total = scores.reduce((sum, n) => sum + (COST[n] ?? 0), 0);
      if (scores.some((n) => n < 8 || n > 15))
        out.push(
          violation(
            'POINT_BUY_RANGE',
            'abilityGeneration.baseAbilities',
            'Point-buy scores must be 8-15',
          ),
        );
      if (total > 27 || scores.some((n) => !(n in COST)))
        out.push(
          violation(
            'POINT_BUY_TOTAL',
            'abilityGeneration.baseAbilities',
            `Point-buy cost ${total} exceeds 27 or contains an invalid score`,
          ),
        );
    }
    if (
      gen.method === 'standard-array' &&
      Object.values(gen.baseAbilities)
        .sort((a, b) => b - a)
        .join(',') !== STANDARD.join(',')
    )
      out.push(
        violation(
          'STANDARD_ARRAY',
          'abilityGeneration.baseAbilities',
          'Standard array must use 15, 14, 13, 12, 10, 8 exactly once',
        ),
      );
    for (const [i, asi] of (gen.asi ?? []).entries()) {
      const allowed = background?.abilityOptions;
      if (allowed?.length && !allowed.includes(asi.ability))
        out.push(
          violation(
            'ASI_NOT_ALLOWED',
            `abilityGeneration.asi.${i}.ability`,
            `${asi.ability} is not offered by background ${background?.name ?? char.backgroundId}`,
          ),
        );
      if (!allowed?.length && !ABILITIES.includes(asi.ability))
        out.push(
          violation(
            'ASI_NOT_ALLOWED',
            `abilityGeneration.asi.${i}.ability`,
            'ASI ability is not legal',
          ),
        );
    }
    if (gen.asi?.length) {
      const expected = { ...gen.baseAbilities };
      for (const asi of gen.asi) expected[asi.ability] += asi.amount;
      for (const asi of char.levelUpAsi ?? []) expected[asi.ability] += asi.amount;
      if (ABILITIES.some((a) => expected[a] !== char.abilities[a]))
        out.push(
          violation(
            'ASI_NOT_ALLOWED',
            'abilities',
            'Final scores do not match the recorded ASI applications',
          ),
        );
    }
  }

  const skills = char.proficiencies.skills;
  const backgroundPicks =
    char.backgroundSkills ??
    skills.filter((s) => background?.skillProficiencies.includes(s));
  if (
    background &&
    (backgroundPicks.length > background.skillProficiencies.length ||
      backgroundPicks.some((s) => !background.skillProficiencies.includes(s)))
  )
    out.push(
      violation(
        'BACKGROUND_SKILL_COUNT',
        'backgroundSkills',
        `Background ${background.name} permits ${background.skillProficiencies.length} skill picks`,
      ),
    );
  const allProfs = [...skills, ...char.proficiencies.tools];
  for (const prof of allProfs)
    if (
      !SKILLS.has(prof) &&
      !entriesOf(catalog).some((e) => e.kind === 'equipment' && e.id === prof)
    )
      out.push(
        violation(
          'INVALID_PROFICIENCY',
          'proficiencies',
          `Invalid proficiency ${prof}`,
        ),
      );
  if (
    new Set(allProfs).size !== allProfs.length ||
    new Set(char.proficiencies.saves).size !== char.proficiencies.saves.length
  )
    out.push(
      violation(
        'DUPLICATE_PROFICIENCY',
        'proficiencies',
        'Proficiencies must not contain duplicates',
      ),
    );

  for (const item of char.equipment)
    if (!entryBy(catalog, 'equipment', item.itemId))
      out.push(
        violation(
          'WRONG_EQUIPMENT',
          'equipment',
          `Unknown equipment ${item.itemId}`,
        ),
      );
  if (char.equipmentOption && klass?.startingEquipment?.length) {
    const option = klass.startingEquipment.find(
      (x) => x.option === char.equipmentOption,
    );
    if (!option)
      out.push(
        violation(
          'WRONG_EQUIPMENT',
          'equipmentOption',
          `Unknown equipment option ${char.equipmentOption}`,
        ),
      );
    else {
      const itemNames = char.equipment.map((x) =>
        entryBy(catalog, 'equipment', x.itemId)?.name.toLowerCase(),
      );
      for (const required of option.items) {
        if (/\d+\s*GP/i.test(required) || /\(any\)/i.test(required)) continue;
        const name = required.replace(/^\d+\s+/, '').toLowerCase();
        if (
          !itemNames.some(
            (actual) =>
              actual === name ||
              actual?.includes(name) ||
              name.includes(actual ?? '\0'),
          )
        )
          out.push(
            violation(
              'ABSENT_EQUIPMENT',
              'equipment',
              `Missing starting equipment ${required}`,
            ),
          );
      }
    }
  }
  for (const spellId of [...char.spellsKnown, ...char.spellsPrepared]) {
    const spell = entryBy(catalog, 'spell', spellId);
    if (!spell)
      out.push(
        violation('UNKNOWN_SPELL', 'spells', `Unknown spell ${spellId}`),
      );
    else if (klass && !spell.classes.includes(klass.name.toLowerCase()))
      out.push(
        violation(
          'SPELL_NOT_ON_CLASS_LIST',
          'spells',
          `${spell.name} is not on the ${klass.name} spell list`,
        ),
      );
  }
  return out;
}
