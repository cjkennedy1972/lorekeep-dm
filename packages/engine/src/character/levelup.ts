import type { Ability } from '@game/schema';
import type {
  CharacterCatalog,
  CharacterInput,
  RuleViolation,
} from './types.js';
import { deriveSheet } from './derive.js';
import { validateCharacter } from './validate.js';

export interface LevelUpChoices {
  subclassId?: string;
  asi?: { ability: Ability; amount: number }[];
  /** Optional prepared/known spell selections to add at this level. */
  spellsKnown?: string[];
  spellsPrepared?: string[];
}
export type LevelUpResult =
  | { ok: true; character: CharacterInput }
  | { ok: false; violations: RuleViolation[] };

/** SRD cumulative experience thresholds for character levels 1 through 5. */
export const XP_THRESHOLDS: Readonly<Record<2 | 3 | 4 | 5, number>> = {
  2: 300,
  3: 900,
  4: 2700,
  5: 6500,
};

export function levelForXp(xp: number): number {
  if (!Number.isFinite(xp) || xp < 0)
    throw new RangeError('XP must be a non-negative finite number');
  if (xp >= XP_THRESHOLDS[5]) return 5;
  if (xp >= XP_THRESHOLDS[4]) return 4;
  if (xp >= XP_THRESHOLDS[3]) return 3;
  if (xp >= XP_THRESHOLDS[2]) return 2;
  return 1;
}

/** Add awarded XP without silently applying level-up choices. */
export function awardXp(char: CharacterInput, amount: number): CharacterInput {
  if (!Number.isSafeInteger(amount) || amount < 0)
    throw new RangeError('XP award must be a non-negative safe integer');
  return { ...char, xp: (char.xp ?? 0) + amount };
}

/** Apply a legal level transition (levels 2-5); invalid choices are returned as rule violations. */
export function levelUp(
  char: CharacterInput,
  choices: LevelUpChoices,
  catalog: CharacterCatalog,
): LevelUpResult {
  const nextLevel = char.level + 1;
  const violations: RuleViolation[] = [];
  if (char.level < 1 || char.level >= 5) {
    violations.push({
      code: 'LEVEL_OUT_OF_RANGE',
      path: 'level',
      message: 'Characters can level up only from levels 1-4 in M1.',
    });
  }
  const klass = catalog.get('class', char.classId);
  if (!klass)
    return {
      ok: false,
      violations: [
        {
          code: 'UNKNOWN_CLASS',
          path: 'classId',
          message: `Unknown class ${char.classId}`,
        },
      ],
    };

  const classFeatures = klass.features ?? [];
  const subclassFeature = classFeatures.find(
    (f) => f.level === nextLevel && /subclass/i.test(f.name),
  );
  const asiFeature = classFeatures.some(
    (f) => f.level === nextLevel && /ability score improvement/i.test(f.name),
  );
  const existingSubclass = char.subclassId;
  let subclassId = existingSubclass;
  if (subclassFeature) {
    if (!choices.subclassId)
      violations.push({
        code: 'SUBCLASS_REQUIRED',
        path: 'subclassId',
        message: `Choose a ${klass.name} subclass at level ${nextLevel}.`,
      });
    else {
      const subclass = catalog.get('subclass', choices.subclassId);
      if (!subclass || subclass.classId !== klass.id)
        violations.push({
          code: 'ILLEGAL_SUBCLASS',
          path: 'subclassId',
          message: `${choices.subclassId} is not a legal ${klass.name} subclass.`,
        });
      else subclassId = subclass.id;
    }
  } else if (choices.subclassId && choices.subclassId !== existingSubclass) {
    violations.push({
      code: 'ILLEGAL_SUBCLASS',
      path: 'subclassId',
      message: 'A subclass can only be selected at the class subclass level.',
    });
  }

  const asi = choices.asi ?? [];
  if (asi.length && !asiFeature)
    violations.push({
      code: 'ASI_NOT_ALLOWED',
      path: 'asi',
      message: `Level ${nextLevel} does not grant an Ability Score Improvement.`,
    });
  if (asiFeature && asi.length !== 1 && asi.length !== 2)
    violations.push({
      code: 'ASI_NOT_ALLOWED',
      path: 'asi',
      message: 'Choose one +2 ability or two different +1 abilities.',
    });
  if (
    (asi.length === 1 && asi[0]!.amount !== 2) ||
    (asi.length === 2 && asi.some((x) => x.amount !== 1))
  )
    violations.push({
      code: 'ASI_NOT_ALLOWED',
      path: 'asi',
      message: 'ASI must be +2 to one ability or +1 to two abilities.',
    });
  if (
    new Set(asi.map((x) => x.ability)).size !== asi.length ||
    asi.some((x) => char.abilities[x.ability] + x.amount > 20 || x.amount < 1)
  )
    violations.push({
      code: 'ASI_NOT_ALLOWED',
      path: 'asi',
      message: 'ASI abilities must be distinct and cannot exceed 20.',
    });
  if (violations.length) return { ok: false, violations };

  const abilities = { ...char.abilities };
  for (const pick of asi) abilities[pick.ability] += pick.amount;
  const spellsKnown = [...char.spellsKnown, ...(choices.spellsKnown ?? [])];
  const spellsPrepared = [
    ...char.spellsPrepared,
    ...(choices.spellsPrepared ?? []),
  ];
  const candidate: CharacterInput = {
    ...char,
    level: nextLevel,
    abilities,
    levelUpAsi: [...(char.levelUpAsi ?? []), ...asi],
    ...(subclassId ? { subclassId } : {}),
    spellsKnown,
    spellsPrepared,
  };
  const derived = deriveSheet(candidate, catalog);
  const hpIncrease = derived.maxHp - char.hp.max;
  candidate.hp = {
    ...candidate.hp,
    max: derived.maxHp,
    current: Math.min(derived.maxHp, candidate.hp.current + hpIncrease),
  };
  candidate.slots = Object.fromEntries(
    Object.entries(derived.spellSlots).map(([level, max]) => [
      level,
      { max, used: char.slots[level]?.used ?? 0 },
    ]),
  );
  const charViolations = validateCharacter(candidate, catalog);
  return charViolations.length
    ? { ok: false, violations: charViolations }
    : { ok: true, character: candidate };
}
