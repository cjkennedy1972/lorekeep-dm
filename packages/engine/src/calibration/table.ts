import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { runPool, readRows } from './pool.js';
import { CLASS_SLUGS, type PolicyVersion } from './pc.js';
import {
  DEFAULT_GRID,
  fitTable,
  LABELS,
  TARGETS,
  type TableCell,
} from './select.js';
import {
  aggregate,
  CALIBRATION_SEED,
  HELDOUT_SEED,
  type CellRow,
  type CellSpec,
} from './sweep.js';

export const POLICY_VERSION = 'solo-cal-pc v2 (see pc.ts)';

/** Verification cells for the fitted table: shipped path (label + multiplier), disjoint seeds. */
export function verificationSpecs(
  levels: Record<string, Record<string, TableCell>>,
  n: { single: number; seq: number; sens: number },
): CellSpec[] {
  const specs: CellSpec[] = [];
  const add = (
    policy: PolicyVersion,
    mode: CellSpec['mode'],
    seeds: number,
  ) => {
    for (const [lv, per] of Object.entries(levels))
      for (const label of LABELS) {
        const c = per[label]!;
        for (const classSlug of CLASS_SLUGS)
          specs.push({
            policy,
            level: Number(lv),
            classSlug,
            k: c.multiplier,
            maxEnemies: c.maxEnemies ?? null,
            label,
            seeds,
            seedBase: HELDOUT_SEED,
            mode,
          });
      }
  };
  add('v2', 'single', n.single);
  add('v2', 'seq-short', n.seq);
  add('v2', 'seq-none', n.seq);
  add('v1', 'single', n.sens);
  add('v0', 'single', n.sens);
  return specs;
}

export function summarize(rows: readonly CellRow[]) {
  const out: Record<string, ReturnType<typeof aggregate>> = {};
  const groups = new Map<string, CellRow[]>();
  for (const r of rows) {
    const key = [r.policy, r.mode, r.level, r.label].join('|');
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  for (const [k, g] of groups) out[k] = aggregate(g);
  return out;
}

const git = (...args: string[]) =>
  execFileSync('git', args, { encoding: 'utf8' }).trim();

export type Paths = {
  sweep: string;
  verify: string;
  table: string;
  results: string;
};

/** Fit from the sweep file, verify on held-out seeds, write the table and the results file. */
export async function buildTable(paths: Paths, workers: number, date: string) {
  const fitted = fitTable(readRows(paths.sweep));
  const specs = verificationSpecs(fitted, { single: 100, seq: 40, sens: 40 });
  await runPool(specs, paths.verify, workers, (d, t) => {
    if (d % 100 === 0 || d === t) console.log(`verify ${d}/${t}`);
  });
  const verification = summarize(readRows(paths.verify));
  const provenance = {
    version: 1,
    gitSha: git('rev-parse', 'HEAD'),
    date,
    policy: POLICY_VERSION,
    calibrationSeed: CALIBRATION_SEED,
    heldoutSeed: HELDOUT_SEED,
    seedsPerCell: DEFAULT_GRID.seeds,
    grid: { ks: DEFAULT_GRID.ks, caps: DEFAULT_GRID.caps },
    targets: TARGETS,
    targetsApproved: true,
  };
  const table = { ...provenance, levels: fitted };
  writeFileSync(paths.table, `${JSON.stringify(table, null, 2)}\n`);
  writeFileSync(
    paths.results,
    `${JSON.stringify({ provenance, fitted, verification }, null, 2)}\n`,
  );
  return { table, verification };
}
