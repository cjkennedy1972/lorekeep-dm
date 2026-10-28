import type { Ability, CatalogEntry } from '@game/schema';
import { deriveSheet } from './derive.js';
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
const ARMOR_PROFICIENCY: Record<string, string> = {
  'padded armor': 'Light armor',
  'leather armor': 'Light armor',
  'studded leather armor': 'Light armor',
  'hide armor': 'Medium armor',
  'chain shirt': 'Medium armor',
  'scale mail': 'Medium armor',
  breastplate: 'Medium armor',
  'half plate armor': 'Medium armor',
  'ring mail': 'Heavy armor',
  'chain mail': 'Heavy armor',
  'splint armor': 'Heavy armor',
  'plate armor': 'Heavy armor',
};
const TWO_HANDED_WEAPONS = new Set([
  'greataxe',
  'greatclub',
  'greatsword',
  'glaive',
  'halberd',
  'heavy crossbow',
  'light crossbow',
  'longbow',
  'maul',
  'musket',
  'pike',
  'shortbow',
]);
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

  if (ABILITIES.some((a) => char.abilities[a] < 1 || char.abilities[a] > 20))
    out.push(
      violation(
        'ABILITY_RANGE',
        'abilities',
        'Ability scores must be in range 1-20',
      ),
    );
  if (char.abilityGeneration) {
    const gen = char.abilityGeneration;
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
      for (const asi of char.levelUpAsi ?? [])
        expected[asi.ability] += asi.amount;
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

  const equipped = char.equipment.filter((item) => item.equipped);
  const equippedBodyArmor = equipped.filter((item) => {
    const entry = entryBy(catalog, 'equipment', item.itemId);
    return entry?.category === 'armor' && entry.name.toLowerCase() !== 'shield';
  });
  const equippedShields = equipped.filter((item) => {
    const entry = entryBy(catalog, 'equipment', item.itemId);
    return entry?.category === 'armor' && entry.name.toLowerCase() === 'shield';
  });
  const equippedWeapons = equipped.filter(
    (item) => entryBy(catalog, 'equipment', item.itemId)?.category === 'weapon',
  );
  let invalidEquippedLoadout =
    equippedBodyArmor.length > 1 ||
    equippedShields.length > 1 ||
    equippedWeapons.length > 2;
  const selectedEquipmentOption = klass?.startingEquipment?.find(
    (option) => option.option === char.equipmentOption,
  );
  if (
    (equippedBodyArmor.length || equippedShields.length) &&
    klass?.startingEquipment?.length &&
    !char.equipmentOption
  )
    invalidEquippedLoadout = true;
  for (const item of [...equippedBodyArmor, ...equippedShields]) {
    const entry = entryBy(catalog, 'equipment', item.itemId);
    if (!entry || item.qty <= 0) {
      invalidEquippedLoadout = true;
      continue;
    }
    const requiredProficiency =
      entry.name.toLowerCase() === 'shield'
        ? 'Shields'
        : ARMOR_PROFICIENCY[entry.name.toLowerCase()];
    if (
      !requiredProficiency ||
      !klass?.armorProficiencies?.includes(requiredProficiency)
    )
      invalidEquippedLoadout = true;
    if (char.equipmentOption && klass?.startingEquipment?.length) {
      const selectedNames = (selectedEquipmentOption?.items ?? []).flatMap(
        (text) =>
          text.split(/\bor\b/i).map((name) =>
            name
              .replace(/^\d+\s+/, '')
              .replace(/\s*\([^)]*\)/g, '')
              .replace(/[’‘]/g, "'")
              .trim()
              .toLowerCase(),
          ),
      );
      if (
        !selectedNames.includes(entry.name.replace(/[’‘]/g, "'").toLowerCase())
      )
        invalidEquippedLoadout = true;
    }
  }
  for (const item of equippedWeapons)
    if (item.qty <= 0) invalidEquippedLoadout = true;
  if (
    equippedShields.length &&
    equippedWeapons.some((item) => {
      const name = entryBy(
        catalog,
        'equipment',
        item.itemId,
      )?.name.toLowerCase();
      return name !== undefined && TWO_HANDED_WEAPONS.has(name);
    })
  )
    invalidEquippedLoadout = true;
  if (invalidEquippedLoadout)
    out.push(
      violation(
        'WRONG_EQUIPMENT',
        'equipment',
        'Equipped equipment is not valid for this character.',
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
      const normalizeItemName = (value: string) =>
        value.replace(/[’‘]/g, "'").toLowerCase();
      const itemNames = char.equipment.map((x) => {
        const name = entryBy(catalog, 'equipment', x.itemId)?.name;
        return name ? normalizeItemName(name) : undefined;
      });
      for (const required of option.items) {
        if (
          /\d+\s*GP/i.test(required) ||
          /\(any\)/i.test(required) ||
          /\bor\b/i.test(required)
        )
          continue;
        const name = normalizeItemName(required.replace(/^\d+\s+/, ''));
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
  if (klass && char.level >= 1 && char.level <= 5) {
    const derived = deriveSheet(char, catalog);
    if (char.hp.max !== derived.maxHp || char.hp.current > char.hp.max)
      out.push(
        violation(
          'HP_MISMATCH',
          'hp',
          `HP must use level ${char.level} hit points (${derived.maxHp} max)`,
        ),
      );
    const expectedSlots: Record<string, number> = { ...derived.spellSlots };
    if (klass.pactMagic)
      for (const slotLevel of Object.keys(expectedSlots))
        delete expectedSlots[slotLevel];
    const pact = klass.pactMagic?.[char.level - 1];
    if (pact) {
      for (const level of Object.keys(expectedSlots))
        delete expectedSlots[level];
      expectedSlots[String(pact.slotLevel)] = pact.slots;
    }
    const actualSlots = Object.fromEntries(
      Object.entries(char.slots)
        .filter(([, slot]) => slot.max > 0)
        .map(([level, slot]) => [level, slot.max]),
    );
    if (
      JSON.stringify(Object.entries(actualSlots).sort()) !==
        JSON.stringify(Object.entries(expectedSlots).sort()) ||
      Object.values(char.slots).some(
        (slot) => slot.used < 0 || slot.used > slot.max,
      )
    )
      out.push(
        violation(
          'WRONG_SPELL_SLOTS',
          'slots',
          `Spell slots do not match level ${char.level} class progression`,
        ),
      );
    const cantrips = klass.cantripsKnown?.[char.level - 1];
    if (cantrips !== undefined && char.spellsKnown.length > cantrips)
      out.push(
        violation(
          'TOO_MANY_SPELLS',
          'spellsKnown',
          `At most ${cantrips} known cantrips at level ${char.level}`,
        ),
      );
    const prepared = klass.preparedSpells?.[char.level - 1];
    if (prepared !== undefined && char.spellsPrepared.length > prepared)
      out.push(
        violation(
          'TOO_MANY_SPELLS',
          'spellsPrepared',
          `At most ${prepared} prepared spells at level ${char.level}`,
        ),
      );
    const subclassRequired = (klass.features ?? []).some(
      (f) => f.level <= char.level && /subclass/i.test(f.name),
    );
    if (subclassRequired && !char.subclassId)
      out.push(
        violation(
          'MISSING_SUBCLASS',
          'subclassId',
          `Choose a ${klass.name} subclass by level ${char.level}`,
        ),
      );
    if (char.subclassId) {
      const subclass = entryBy(catalog, 'subclass', char.subclassId);
      if (!subclass || subclass.classId !== klass.id)
        out.push(
          violation(
            'ILLEGAL_SUBCLASS',
            'subclassId',
            `${char.subclassId} is not a legal ${klass.name} subclass`,
          ),
        );
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
  for (const condition of char.conditions)
    if (!entryBy(catalog, 'condition', condition.conditionId))
      out.push(
        violation(
          'UNKNOWN_CONDITION',
          'conditions',
          `Unknown condition ${condition.conditionId}`,
        ),
      );
  return out;
}
