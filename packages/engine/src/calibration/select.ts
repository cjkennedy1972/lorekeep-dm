import { encounterBudget, type EncounterDifficulty } from '../encounter/budget.js';
import { aggregate, type Agg, type CellRow } from './sweep.js';

export type Band = {
  winMin: number;
  winMax?: number;
  /** Mean fraction of max HP lost in fights the PC won (class-weighted). */
  hpLostMin?: number;
  hpLostMax?: number;
};

/**
 * Outcome targets per label. PENDING HUMAN APPROVAL: they are the proposal from the SOLO-CAL brief,
 * justified in docs/plan/verification/solo-calibration.md, and are not tuned to what the sim can reach.
 */
export const TARGETS: Record<EncounterDifficulty, Band> = {
  low: { winMin: 0.97, hpLostMax: 0.35 },
  moderate: { winMin: 0.9, hpLostMin: 0.4, hpLostMax: 0.65 },
  high: { winMin: 0.75, hpLostMin: 0.6, hpLostMax: 0.85 },
  deadly: { winMin: 0.35, winMax: 0.6 },
};
export const LABELS: readonly EncounterDifficulty[] = [
  'low',
  'moderate',
  'high',
  'deadly',
];

/** How far `agg` is outside `band`, as the largest shortfall in absolute rate (0 = inside the band). */
export function violation(agg: Agg, band: Band): number {
  const gaps = [
    band.winMin - agg.win,
    band.winMax === undefined ? 0 : agg.win - band.winMax,
    band.hpLostMin === undefined ? 0 : band.hpLostMin - agg.hpLostWin,
    band.hpLostMax === undefined ? 0 : agg.hpLostWin - band.hpLostMax,
  ];
  return Math.max(0, ...gaps.map((g) => (Number.isNaN(g) ? 1 : g)));
}

export type Choice = {
  /** Multiplier of the SRD *moderate* per-character budget in the sweep. */
  k: number;
  maxEnemies: number | null;
  agg: Agg;
  violation: number;
};

const cellKey = (r: CellRow) => `${r.level}|${r.maxEnemies}|${r.k}`;

/** Class-weighted aggregates per (level, cap, k). */
export function groupCells(rows: readonly CellRow[]) {
  const by = new Map<string, CellRow[]>();
  for (const r of rows) {
    const g = by.get(cellKey(r)) ?? [];
    g.push(r);
    by.set(cellKey(r), g);
  }
  return [...by.values()].map((g) => ({
    level: g[0]!.level,
    k: g[0]!.k,
    maxEnemies: g[0]!.maxEnemies,
    agg: aggregate(g),
  }));
}

/**
 * Pick the cell for a (level, label): among cells inside the band take the one spending the most
 * XP (the hardest encounter that still meets the targets), ties to the smaller k and cap. If none
 * is inside, take the least-violating cell, which the caller reports as unmet.
 */
export function choose(
  cells: ReturnType<typeof groupCells>,
  level: number,
  band: Band,
): Choice {
  const scored = cells
    .filter((c) => c.level === level)
    .map((c) => ({
      k: c.k,
      maxEnemies: c.maxEnemies,
      agg: c.agg,
      violation: violation(c.agg, band),
    }));
  if (!scored.length) throw new Error(`no sweep cells for level ${level}`);
  const inside = scored.filter((c) => c.violation === 0);
  const tie = (a: Choice, b: Choice) =>
    a.k - b.k || (a.maxEnemies ?? 99) - (b.maxEnemies ?? 99);
  if (inside.length)
    return inside.sort((a, b) => b.agg.spent - a.agg.spent || tie(a, b))[0]!;
  return scored.sort(
    (a, b) => a.violation - b.violation || b.agg.spent - a.agg.spent || tie(a, b),
  )[0]!;
}

/** Table multiplier for `label` reproducing the sweep's absolute budget k x (SRD moderate). */
export function labelMultiplier(
  level: number,
  label: EncounterDifficulty,
  k: number,
): number {
  const wanted = Math.floor(k * encounterBudget(level, 1, 'moderate') + 1e-9);
  const row = encounterBudget(level, 1, label);
  return Math.ceil((wanted / row) * 10000) / 10000;
}

/** The grid the shipped table was fitted on (regenerate re-runs exactly this). */
export const DEFAULT_GRID = {
  policy: 'v2' as const,
  levels: [1, 2, 3, 4, 5],
  caps: [1, 2, 3, null] as (number | null)[],
  ks: [
    0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.15, 1.3, 1.5, 1.75, 2,
    2.5, 3, 4,
  ],
  seeds: 30,
};

export type TableCell = {
  multiplier: number;
  maxEnemies?: number;
  /** Did the fitted cell satisfy the band on the calibration seeds? */
  met: boolean;
  /** Fitted class-mean outcome on the calibration seeds. */
  fit: { win: number; hpLostWin: number; enemies: number; spent: number };
};

/** Pure: sweep rows -> the (level, label) table. */
export function fitTable(rows: readonly CellRow[]) {
  const cells = groupCells(
    rows.filter(
      (r) =>
        r.mode === 'single' && !r.label && r.policy === DEFAULT_GRID.policy,
    ),
  );
  const levels: Record<string, Record<string, TableCell>> = {};
  for (const level of DEFAULT_GRID.levels) {
    const perLabel: Record<string, TableCell> = {};
    for (const label of LABELS) {
      const c = choose(cells, level, TARGETS[label]);
      perLabel[label] = {
        multiplier: labelMultiplier(level, label, c.k),
        ...(c.maxEnemies !== null ? { maxEnemies: c.maxEnemies } : {}),
        met: c.violation === 0,
        fit: {
          win: round(c.agg.win),
          hpLostWin: round(c.agg.hpLostWin),
          enemies: round(c.agg.enemies),
          spent: Math.round(c.agg.spent),
        },
      };
    }
    levels[String(level)] = perLabel;
  }
  return levels;
}
const round = (x: number) => Math.round(x * 1000) / 1000;
