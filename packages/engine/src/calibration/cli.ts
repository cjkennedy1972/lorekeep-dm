import { fileURLToPath } from 'node:url';
import { runPool } from './pool.js';
import { DEFAULT_GRID } from './select.js';
import { writeReport } from './report.js';
import { buildTable } from './table.js';
import { CLASS_SLUGS, POLICY_VERSIONS, type PolicyVersion } from './pc.js';
import { CALIBRATION_SEED, type CellSpec } from './sweep.js';

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
};
const list = (v: string) => v.split(',').filter(Boolean);

const cmd = process.argv[2];
if (cmd === 'sweep') {
  const out = arg('out', 'sweep.jsonl');
  const policies = list(arg('policies', 'v1')) as PolicyVersion[];
  for (const p of policies)
    if (!POLICY_VERSIONS.includes(p)) throw new Error(`bad policy ${p}`);
  const levels = list(arg('levels', '1,2,3,4,5')).map(Number);
  const caps = list(arg('caps', '1,2,3,4,none')).map((c) =>
    c === 'none' ? null : Number(c),
  );
  const ks = list(
    arg('ks', '0.25,0.4,0.5,0.6,0.75,0.9,1,1.25,1.5,2,2.5,3,4,5,6'),
  ).map(Number);
  const seeds = Number(arg('seeds', '60'));
  const seedBase = Number(arg('seedBase', String(CALIBRATION_SEED)));
  const mode = arg('mode', 'single') as CellSpec['mode'];
  const specs: CellSpec[] = [];
  for (const policy of policies)
    for (const level of levels)
      for (const maxEnemies of caps)
        for (const k of ks)
          for (const classSlug of CLASS_SLUGS)
            specs.push({
              policy,
              level,
              classSlug,
              k,
              maxEnemies,
              seeds,
              seedBase,
              mode,
            });
  const t0 = process.hrtime.bigint();
  await runPool(specs, out, Number(arg('workers', '2')), (d, t) => {
    if (d % 100 === 0 || d === t)
      console.log(
        `${d}/${t} cells, ${(Number(process.hrtime.bigint() - t0) / 1e9).toFixed(0)}s`,
      );
  });
} else if (cmd === 'regenerate' || cmd === 'build-table') {
  const here = (p: string) =>
    fileURLToPath(new URL(`../../${p}`, import.meta.url));
  const paths = {
    sweep: here('calibration-data/solo-sweep.v1.jsonl'),
    verify: here('calibration-data/solo-verify.v1.jsonl'),
    table: here('src/encounter/solo-difficulty.v1.json'),
    results: fileURLToPath(
      new URL(
        '../../../../docs/plan/verification/solo-calibration-results.json',
        import.meta.url,
      ),
    ),
  };
  const workers = Number(arg('workers', '1'));
  if (cmd === 'regenerate') {
    const g = DEFAULT_GRID;
    const specs: CellSpec[] = [];
    for (const level of g.levels)
      for (const maxEnemies of g.caps)
        for (const k of g.ks)
          for (const classSlug of CLASS_SLUGS)
            specs.push({
              policy: g.policy,
              level,
              classSlug,
              k,
              maxEnemies,
              seeds: g.seeds,
              seedBase: CALIBRATION_SEED,
              mode: 'single',
            });
    await runPool(specs, paths.sweep, workers, (d, t) => {
      if (d % 200 === 0 || d === t) console.log(`sweep ${d}/${t}`);
    });
  }
  await buildTable(paths, workers, arg('date', 'undated'));
  writeReport(
    fileURLToPath(
      new URL(
        '../../../../docs/plan/verification/solo-calibration.md',
        import.meta.url,
      ),
    ),
    paths.table,
    paths.verify,
  );
} else {
  console.log(
    'usage: cli.js regenerate|build-table [--workers 1] | sweep --out f.jsonl [--policies v1] [--levels 1,2] [--caps 1,2,3,none] [--ks ...] [--seeds 60] [--workers 2]',
  );
}
