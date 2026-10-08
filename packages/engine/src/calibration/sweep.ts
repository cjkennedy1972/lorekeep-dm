import type { Catalog } from '../catalog/types.js';
import { encounterFor, mixSeed, runFight, runSequence } from './fight.js';
import { buildPc, CLASS_SLUGS, type PolicyVersion } from './pc.js';

/** Seed bases: the fit uses CALIBRATION_SEED; the quoted verification uses a disjoint HELDOUT_SEED. */
export const CALIBRATION_SEED = 20261008;
export const HELDOUT_SEED = 20261009;

export type CellSpec = {
  policy: PolicyVersion;
  level: number;
  classSlug: string;
  /** Multiplier of the SRD *moderate* per-character budget (k). */
  k: number;
  maxEnemies: number | null;
  seeds: number;
  seedBase: number;
  mode: 'single' | 'seq-none' | 'seq-short';
};

/** Raw counts for one cell; everything the fit and the report need is derivable from these. */
export type CellRow = CellSpec & {
  n: number;
  wins: number;
  kos: number;
  deaths: number;
  /** Sum over won fights of the fraction of max HP lost. */
  hpLostWins: number;
  /** Sum over all fights of the fraction of max HP lost (losses count as the HP they lost). */
  hpLostAll: number;
  rounds: number;
  spentXp: number;
  enemies: number;
  /** Sequence modes only: survived all fights / won all fights, and fight-3 reach. */
  survivedAll?: number;
  wonAll?: number;
};

export function runCell(catalog: Catalog, spec: CellSpec): CellRow {
  const pc = buildPc(
    catalog,
    `class:${spec.classSlug}`,
    spec.level,
    spec.policy,
  );
  const shape = {
    multiplier: spec.k,
    ...(spec.maxEnemies !== null ? { maxEnemies: spec.maxEnemies } : {}),
  };
  const classIndex = CLASS_SLUGS.indexOf(pc.slug);
  const row: CellRow = {
    ...spec,
    n: 0,
    wins: 0,
    kos: 0,
    deaths: 0,
    hpLostWins: 0,
    hpLostAll: 0,
    rounds: 0,
    spentXp: 0,
    enemies: 0,
    ...(spec.mode !== 'single' ? { survivedAll: 0, wonAll: 0 } : {}),
  };
  for (let i = 0; i < spec.seeds; i++) {
    const seed = mixSeed(spec.seedBase, spec.level, classIndex, i);
    if (spec.mode === 'single') {
      const enc = encounterFor(catalog, spec.level, shape, mixSeed(seed, 1));
      const { result } = runFight(
        catalog,
        pc,
        pc.fresh(),
        enc,
        mixSeed(seed, 2),
      );
      const lost = 1 - result.hpEnd / pc.maxHp;
      row.n += 1;
      row.wins += result.win ? 1 : 0;
      row.kos += result.ko ? 1 : 0;
      row.deaths += result.dead ? 1 : 0;
      row.hpLostWins += result.win ? lost : 0;
      row.hpLostAll += lost;
      row.rounds += result.rounds;
      row.spentXp += enc.spent;
      row.enemies += enc.monsters.length;
    } else {
      const seq = runSequence(
        catalog,
        pc,
        spec.level,
        shape,
        seed,
        spec.mode === 'seq-short' ? 'short' : 'none',
      );
      const last = seq.fights[seq.fights.length - 1]!;
      row.n += 1;
      row.survivedAll! += seq.survived ? 1 : 0;
      row.wonAll! += seq.wonAll ? 1 : 0;
      row.wins += last.win ? 1 : 0;
      row.kos += seq.fights.some((f) => f.ko) ? 1 : 0;
      row.deaths += last.dead ? 1 : 0;
      row.hpLostWins += seq.wonAll ? 1 - last.hpEnd / pc.maxHp : 0;
      row.hpLostAll += 1 - last.hpEnd / pc.maxHp;
      row.rounds += seq.fights.reduce((n, f) => n + f.rounds, 0);
    }
  }
  return row;
}

// ---- aggregation -----------------------------------------------------------

export type Agg = {
  n: number;
  win: number;
  winLo: number;
  winHi: number;
  ko: number;
  death: number;
  /** Mean fraction of max HP lost in won fights. */
  hpLostWin: number;
  hpLostAll: number;
  rounds: number;
  spent: number;
  enemies: number;
};

/** Wilson 95% interval; treats the pooled classes as one sample of fights. */
export function wilson(wins: number, n: number): [number, number] {
  if (!n) return [0, 1];
  const z = 1.96;
  const p = wins / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const h = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (c - h) / d), Math.min(1, (c + h) / d)];
}

/**
 * Class-weighted aggregate: every class counts equally ("the average single character"),
 * so rates are the mean of per-class rates rather than a pooled-fight rate.
 */
export function aggregate(rows: readonly CellRow[]): Agg {
  const per = rows.map((r) => ({
    win: r.wins / r.n,
    ko: r.kos / r.n,
    death: r.deaths / r.n,
    hpLostWin: r.wins ? r.hpLostWins / r.wins : NaN,
    hpLostAll: r.hpLostAll / r.n,
    rounds: r.rounds / r.n,
    spent: r.spentXp / r.n,
    enemies: r.enemies / r.n,
  }));
  const mean = (f: (p: (typeof per)[number]) => number) => {
    const xs = per.map(f).filter((x) => !Number.isNaN(x));
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
  };
  const n = rows.reduce((s, r) => s + r.n, 0);
  const win = mean((p) => p.win);
  const [winLo, winHi] = wilson(Math.round(win * n), n);
  return {
    n,
    win,
    winLo,
    winHi,
    ko: mean((p) => p.ko),
    death: mean((p) => p.death),
    hpLostWin: mean((p) => p.hpLostWin),
    hpLostAll: mean((p) => p.hpLostAll),
    rounds: mean((p) => p.rounds),
    spent: mean((p) => p.spent),
    enemies: mean((p) => p.enemies),
  };
}
