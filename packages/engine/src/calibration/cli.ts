import { runPool } from './pool.js';
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
  const t0 = Date.now();
  await runPool(specs, out, Number(arg('workers', '2')), (d, t) => {
    if (d % 100 === 0 || d === t)
      console.log(`${d}/${t} cells, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  });
} else {
  console.log(
    'usage: cli.js sweep --out f.jsonl [--policies v1] [--levels 1,2] [--caps 1,2,3,none] [--ks ...] [--seeds 60] [--workers 2]',
  );
}
