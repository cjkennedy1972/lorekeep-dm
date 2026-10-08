import type { Catalog } from '../catalog/types.js';
import { seedRng, nextFloat } from '../rng.js';

export type EncounterDifficulty = 'low' | 'moderate' | 'high';
export interface EncounterRequest {
  level: number;
  partySize?: number;
  difficulty?: EncounterDifficulty;
  seed: number;
}
export interface BuiltEncounter {
  difficulty: EncounterDifficulty;
  budget: number;
  spent: number;
  remaining: number;
  monsters: { id: string; name: string; cr: number; xp: number }[];
}
export class EncounterBuildError extends Error {}

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
  return XP_BUDGET[level]![DIFFICULTY_INDEX[difficulty]] * partySize;
}

export function buildEncounter(
  catalog: Catalog,
  request: EncounterRequest,
): BuiltEncounter {
  const difficulty = request.difficulty ?? 'moderate';
  const budget = encounterBudget(
    request.level,
    request.partySize ?? 1,
    difficulty,
  );
  let state = seedRng(request.seed);
  const eligible = catalog.entries
    .filter(
      (entry) =>
        entry.kind === 'monster' &&
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
  while (true) {
    const fitting = eligible.filter((monster) => spent + monster.xp <= budget);
    if (!fitting.length) break;
    const [roll, next] = nextFloat(state);
    state = next;
    const chosen = fitting[Math.floor(roll * fitting.length)]!;
    monsters.push(chosen);
    spent += chosen.xp;
  }
  return { difficulty, budget, spent, remaining: budget - spent, monsters };
}
