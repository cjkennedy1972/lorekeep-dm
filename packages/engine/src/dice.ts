import { nextDie, type RngState } from './rng.js';

export interface DieResult {
  sides: number;
  value: number;
  kept: boolean;
}
export interface Modifier {
  label: string;
  value: number;
}
/** Single shape shown in the UI for any roll. */
export interface RollBreakdown {
  expression: string;
  dice: DieResult[];
  modifiers: Modifier[];
  total: number;
}
export type RollMode = 'normal' | 'advantage' | 'disadvantage';

export interface RollOptions {
  mode?: RollMode;
  /** Labelled modifiers added to the parsed constant. */
  modifiers?: Modifier[];
}

// NdM[kh|kl K][+/-K]
const EXPR = /^(\d+)d(\d+)(?:k([hl])(\d+))?([+-]\d+)?$/;

export function roll(
  expression: string,
  state: RngState,
  opts: RollOptions = {},
): [RollBreakdown, RngState] {
  const m = EXPR.exec(expression.replace(/\s+/g, '').toLowerCase());
  if (!m) throw new Error(`invalid dice expression: ${expression}`);
  let count = Number(m[1]);
  const sides = Number(m[2]);
  if (count < 1 || sides < 1)
    throw new Error(`invalid dice expression: ${expression}`);
  let keep = m[3] ? Number(m[4]) : count;
  let keepHigh = m[3] !== 'l';
  const mode = opts.mode ?? 'normal';
  if (mode !== 'normal') {
    if (count !== 1 || sides !== 20 || m[3])
      throw new Error('advantage/disadvantage applies to a plain 1d20');
    count = 2;
    keep = 1;
    keepHigh = mode === 'advantage';
  }
  if (keep < 1 || keep > count)
    throw new Error(`invalid keep count: ${expression}`);

  const dice: DieResult[] = [];
  for (let i = 0; i < count; i++) {
    let v: number;
    [v, state] = nextDie(state, sides);
    dice.push({ sides, value: v, kept: false });
  }
  const order = dice
    .map((d, i) => i)
    .sort(
      (a, b) =>
        (keepHigh
          ? dice[b]!.value - dice[a]!.value
          : dice[a]!.value - dice[b]!.value) || a - b,
    );
  for (const i of order.slice(0, keep)) dice[i]!.kept = true;

  const modifiers: Modifier[] = [];
  if (m[5]) modifiers.push({ label: 'expression', value: Number(m[5]) });
  modifiers.push(...(opts.modifiers ?? []));
  const total =
    dice.filter((d) => d.kept).reduce((s, d) => s + d.value, 0) +
    modifiers.reduce((s, x) => s + x.value, 0);
  return [{ expression, dice, modifiers, total }, state];
}

export const abilityModifier = (score: number): number =>
  Math.floor((score - 10) / 2);
export const proficiencyBonus = (level: number): number =>
  Math.ceil(level / 4) + 1;
