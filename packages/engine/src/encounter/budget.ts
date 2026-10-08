import type { Catalog } from '../catalog/types.js';
import { seedRng, nextFloat } from '../rng.js';
import soloTable from './solo-difficulty.v1.json' with { type: 'json' };

/**
 * `low`, `moderate` and `high` are the SRD labels (easy/moderate/hard in design talk).
 * `deadly` is original solo tuning with no SRD counterpart (see solo-calibration.md).
 */
export type EncounterDifficulty = 'low' | 'moderate' | 'high' | 'deadly';
/** Original tuning, not SRD: scale the SRD budget and optionally cap the enemy count. */
export interface SoloBudgetModel {
  multiplier: number;
  maxEnemies?: number;
}
export interface EncounterRequest {
  level: number;
  partySize?: number;
  difficulty?: EncounterDifficulty;
  seed: number;
  /**
   * How a solo (partySize 1) budget is derived. `calibrated` (the solo default) reads the
   * versioned table in solo-difficulty.v1.json; `srd` is the plain 1x per-character budget;
   * an object applies an explicit multiplier. Ignored for parties.
   */
  soloBudget?: 'calibrated' | 'srd' | SoloBudgetModel;
}
export interface BuiltEncounter {
  difficulty: EncounterDifficulty;
  budget: number;
  /** The SRD per-character budget before any solo scaling (deadly is based on SRD high). */
  srdBudget: number;
  model: 'srd' | 'calibrated' | 'explicit';
  multiplier: number;
  maxEnemies?: number;
  spent: number;
  remaining: number;
  monsters: { id: string; name: string; cr: number; xp: number }[];
}
export class EncounterBuildError extends Error {}

type SoloCell = { multiplier: number; maxEnemies?: number };
/** Calibrated solo scaling for a level and label; the table's `levels` rows carry it. */
export function soloCalibration(
  level: number,
  difficulty: EncounterDifficulty,
): SoloCell {
  const cell = (
    soloTable.levels as Record<string, Record<string, SoloCell> | undefined>
  )[String(level)]?.[difficulty];
  if (!cell)
    throw new EncounterBuildError(
      'No solo calibration for this level and difficulty.',
    );
  return cell;
}

// SRD 5.2.1, Playing the Game > Gameplay Toolbox > Combat Encounters,
// “XP Budget per Character” and Step 2 (PDF pp. 64–65): multiply the
// per-character value by party size. For a solo PC this is exactly 1x;
// the SRD specifies no solo-specific modifier, so none is invented here.
const XP_BUDGET: Readonly<Record<number, readonly [number, number, number]>> = {
  1: [50, 75, 100],
  2: [100, 150, 200],
  3: [150, 225, 400],
  4: [250, 375, 500],
  5: [500, 750, 1100],
};
const XP_BY_CR: Readonly<Record<number, number>> = {
  0: 10,
  0.125: 25,
  0.25: 50,
  0.5: 100,
  1: 200,
  2: 450,
  3: 700,
  4: 1100,
  5: 1800,
};
const DIFFICULTY_INDEX: Readonly<Record<EncounterDifficulty, number>> = {
  low: 0,
  moderate: 1,
  high: 2,
  deadly: 2, // SRD has no deadly row; the solo table scales the High row
};

export function encounterBudget(
  level: number,
  partySize = 1,
  difficulty: EncounterDifficulty = 'moderate',
): number {
  if (!Number.isInteger(level) || !(level in XP_BUDGET))
    throw new EncounterBuildError('Level must be an integer from 1 through 5.');
  if (!Number.isInteger(partySize) || partySize < 1 || partySize > 6)
    throw new EncounterBuildError(
      'Party size must be an integer from 1 through 6.',
    );
  if (difficulty === 'deadly' && partySize !== 1)
    throw new EncounterBuildError('Deadly is a solo-only calibrated label.');
  const row = XP_BUDGET[level];
  const index = DIFFICULTY_INDEX[difficulty];
  const perCharacter = row?.[index];
  if (perCharacter === undefined)
    throw new EncounterBuildError('Unknown encounter difficulty.');
  return perCharacter * partySize;
}

export function buildEncounter(
  catalog: Catalog,
  request: EncounterRequest,
): BuiltEncounter {
  const difficulty = request.difficulty ?? 'moderate';
  const partySize = request.partySize ?? 1;
  const srdBudget = encounterBudget(request.level, partySize, difficulty);
  const wanted = partySize === 1 ? (request.soloBudget ?? 'calibrated') : 'srd';
  const scaling: SoloBudgetModel & { model: BuiltEncounter['model'] } =
    wanted === 'srd'
      ? { model: 'srd', multiplier: 1 }
      : wanted === 'calibrated'
        ? { model: 'calibrated', ...soloCalibration(request.level, difficulty) }
        : { model: 'explicit', ...wanted };
  if (!(scaling.multiplier > 0))
    throw new EncounterBuildError('Solo multiplier must be positive.');
  // epsilon: a decimal multiplier times an integer row can land a hair under the intended whole number
  const budget = Math.floor(srdBudget * scaling.multiplier + 1e-9);
  const maxEnemies = scaling.maxEnemies;
  let state = seedRng(request.seed);
  const eligible = catalog.entries
    .filter((entry) => entry.kind === 'monster')
    .filter(
      (entry) =>
        entry.cr <= 5 &&
        (XP_BY_CR[entry.cr] ?? 0) > 0 &&
        (XP_BY_CR[entry.cr] ?? 0) <= budget,
    )
    .map((entry) => ({
      id: entry.id,
      name: entry.name,
      cr: entry.cr,
      xp: XP_BY_CR[entry.cr]!,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  if (!eligible.length)
    throw new EncounterBuildError(
      'No in-scope catalog monsters fit this XP budget.',
    );
  const monsters: BuiltEncounter['monsters'] = [];
  let spent = 0;
  // SRD 5.2.1 p. 65, Step 3: spend as much budget as possible without going over.
  // Seeded randomized greedy choice keeps builds reproducible while respecting that rule.
  while (maxEnemies === undefined || monsters.length < maxEnemies) {
    const fitting = eligible.filter((monster) => spent + monster.xp <= budget);
    if (!fitting.length) break;
    // With one slot left under an enemy cap, take the priciest fit so the cap does not waste budget.
    const pool =
      maxEnemies !== undefined && monsters.length === maxEnemies - 1
        ? fitting.filter(
            (monster) => monster.xp === Math.max(...fitting.map((f) => f.xp)),
          )
        : fitting;
    const [roll, next] = nextFloat(state);
    state = next;
    const chosen = pool[Math.floor(roll * pool.length)]!;
    monsters.push(chosen);
    spent += chosen.xp;
  }
  return {
    difficulty,
    budget,
    srdBudget,
    model: scaling.model,
    multiplier: scaling.multiplier,
    ...(maxEnemies !== undefined ? { maxEnemies } : {}),
    spent,
    remaining: budget - spent,
    monsters,
  };
}
