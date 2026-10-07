import type { Ability } from '@game/schema';
import {
  roll,
  type RollBreakdown,
  type RollMode,
  type Modifier,
} from '../dice.js';
import { nextDie, type RngState } from '../rng.js';
import { effectiveConditions, type ActiveCondition } from './conditions.js';

export type CheckInput = {
  ability: Ability;
  /** Ability modifier. */
  modifier: number;
  /** Skill name, recorded in the breakdown label. */
  skill?: string;
  /** Proficiency bonus added when proficient. */
  proficiencyBonus?: number;
  dc: number;
  /** Why this DC; required so the table can see the reasoning. */
  dcReason: string;
  mode?: RollMode;
  conditions?: readonly ActiveCondition[];
};
export type CheckResult = {
  kind: 'check' | 'save';
  ability: Ability;
  skill?: string;
  dc: number;
  dcReason: string;
  total: number;
  success: boolean;
  autoFail?: string;
  mode: RollMode;
  breakdown: RollBreakdown;
};
type Err = { error: string; hint: string };

function validate(i: CheckInput): Err | null {
  if (!i.dcReason?.trim())
    return {
      error: 'A DC needs a reason.',
      hint: 'Provide dcReason, e.g. "steep wet cliff".',
    };
  if (!Number.isInteger(i.dc) || i.dc < 1 || i.dc > 40)
    return {
      error: 'DC must be an integer from 1 to 40.',
      hint: 'Typical DCs are 10, 15, 20.',
    };
  return null;
}

function run(
  kind: 'check' | 'save',
  i: CheckInput,
  rng: RngState,
): [CheckResult | Err, RngState] {
  const bad = validate(i);
  if (bad) return [bad, rng];
  const ids = effectiveConditions(i.conditions);
  const adv = i.mode === 'advantage';
  let dis = i.mode === 'disadvantage';
  if (kind === 'check' && (ids.has('poisoned') || ids.has('frightened')))
    dis = true;
  if (kind === 'save' && i.ability === 'dex' && ids.has('restrained'))
    dis = true;
  const mode: RollMode =
    adv && dis ? 'normal' : adv ? 'advantage' : dis ? 'disadvantage' : 'normal';
  const modifiers: Modifier[] = [
    {
      label:
        kind === 'check' && i.skill ? `${i.skill} (${i.ability})` : i.ability,
      value: i.modifier,
    },
  ];
  if (i.proficiencyBonus)
    modifiers.push({ label: 'proficiency', value: i.proficiencyBonus });
  const [breakdown, next] = roll('1d20', rng, { mode, modifiers });
  const autoFail =
    kind === 'save' &&
    (i.ability === 'str' || i.ability === 'dex') &&
    (ids.has('stunned') || ids.has('unconscious'))
      ? 'stunned and unconscious creatures automatically fail Strength and Dexterity saves'
      : undefined;
  return [
    {
      kind,
      ability: i.ability,
      skill: i.skill,
      dc: i.dc,
      dcReason: i.dcReason,
      total: breakdown.total,
      success: !autoFail && breakdown.total >= i.dc,
      autoFail,
      mode,
      breakdown,
    },
    next,
  ];
}

export const abilityCheck = (i: CheckInput, rng: RngState) =>
  run('check', i, rng);
export const savingThrow = (i: CheckInput, rng: RngState) =>
  run('save', i, rng);

export type ContestSide = Omit<CheckInput, 'dc' | 'dcReason'>;
/** Both sides roll; higher total wins, a tie leaves things unchanged. */
export function contestedCheck(
  a: ContestSide,
  b: ContestSide,
  rng: RngState,
  dcReason = 'contested check',
): [
  { winner: 'a' | 'b' | 'tie'; a: CheckResult; b: CheckResult } | Err,
  RngState,
] {
  const [ra, r1] = run('check', { ...a, dc: 1, dcReason }, rng);
  if ('error' in ra) return [ra, rng];
  const [rb, r2] = run('check', { ...b, dc: 1, dcReason }, r1);
  if ('error' in rb) return [rb, rng];
  const winner =
    ra.total === rb.total ? 'tie' : ra.total > rb.total ? 'a' : 'b';
  return [{ winner, a: ra, b: rb }, r2];
}

export type DeathSaves = {
  successes: number;
  failures: number;
  stable: boolean;
  dead: boolean;
  hp: number;
};
export const freshDeathSaves = (): DeathSaves => ({
  successes: 0,
  failures: 0,
  stable: false,
  dead: false,
  hp: 0,
});

/** One death save for a creature at 0 HP: nat 20 => 1 HP, nat 1 => 2 failures, <10 fail, >=10 success. */
export function deathSave(
  s: DeathSaves,
  rng: RngState,
): [{ state: DeathSaves; die: number } | Err, RngState] {
  if (s.dead || s.stable || s.hp > 0)
    return [
      {
        error: 'No death save needed.',
        hint: 'Death saves apply only to a dying creature at 0 HP.',
      },
      rng,
    ];
  const [die, next] = nextDie(rng, 20);
  if (die === 20)
    return [{ die, state: { ...freshDeathSaves(), hp: 1 } }, next];
  const successes = s.successes + (die >= 10 ? 1 : 0);
  const failures = s.failures + (die === 1 ? 2 : die < 10 ? 1 : 0);
  return [
    {
      die,
      state: {
        ...s,
        successes,
        failures,
        stable: successes >= 3 && failures < 3,
        dead: failures >= 3,
      },
    },
    next,
  ];
}
