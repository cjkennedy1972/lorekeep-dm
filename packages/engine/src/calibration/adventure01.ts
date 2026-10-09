import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadCatalog } from '../catalog/load.js';
import type { BuiltEncounter } from '../encounter/budget.js';
import { mixSeed, runFight } from './fight.js';
import { buildPc, CLASS_SLUGS } from './pc.js';

/** Level the adventure expects (E3 is level 3: the milestone is awarded before the boss hall) at each encounter (docs/adventures/01-draft.md, Advancement) and the label it claims. */
export const CLAIMS = [
  { id: 'encounter-e1-rats', level: 1, label: 'low' },
  { id: 'encounter-e2-lookouts', level: 2, label: 'moderate' },
  { id: 'encounter-e3-skarrik', level: 3, label: 'high' },
  { id: 'encounter-e4-wardens', level: 3, label: 'high' },
] as const;
const SEED_BASE = 20261010;

const adventure = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL('../../adventures/01/adventure.json', import.meta.url),
    ),
    'utf8',
  ),
) as { encounters: { id: string; monsterIds: string[] }[] };
const catalog = loadCatalog();
const seeds = Number(process.argv[2] ?? 200);

const asBuilt = (ids: string[]): BuiltEncounter => ({
  difficulty: 'moderate',
  budget: 0,
  srdBudget: 0,
  model: 'explicit',
  multiplier: 1,
  spent: 0,
  remaining: 0,
  monsters: ids.map((id) => ({ id, name: id, cr: 0, xp: 0 })),
});

const only = process.env.ONLY;
const rows = CLAIMS.filter((c) => !only || c.id === only).map(
  ({ id, level, label }) => {
    // TRY="encounter-e1-rats=monster:giant-rat;..." tries candidate rosters without editing the data
    const tried = process.env.TRY?.split(';').find((t) =>
      t.startsWith(`${id}=`),
    );
    const ids = tried
      ? tried.slice(id.length + 1).split(',')
      : adventure.encounters.find((e) => e.id === id)!.monsterIds;
    const enc = asBuilt(ids);
    const perClass = CLASS_SLUGS.map((slug, ci) => {
      const pc = buildPc(catalog, `class:${slug}`, level, 'v2');
      let wins = 0,
        ko = 0,
        hp = 0,
        dayWinAll = 0,
        dayHp = 0;
      for (let i = 0; i < seeds; i++) {
        const seed = mixSeed(SEED_BASE, level, ci, i);
        const r = runFight(
          catalog,
          pc,
          pc.fresh(),
          enc,
          mixSeed(seed, 2),
        ).result;
        wins += r.win ? 1 : 0;
        ko += r.ko ? 1 : 0;
        hp += r.win ? 1 - r.hpEnd / pc.maxHp : 0;
        // 3-fight day, same encounter, short rest between (the calibration's day definition)
        let day = pc.fresh();
        let last = 0,
          all = true;
        for (let f = 0; f < 3; f++) {
          const o = runFight(catalog, pc, day, enc, mixSeed(seed, f, 3));
          if (!o.result.win) {
            all = false;
            last = 1 - o.result.hpEnd / pc.maxHp;
            break;
          }
          last = 1 - o.next.hp / pc.maxHp;
          day = f < 2 ? pc.rest(o.next, 'short') : o.next;
        }
        dayWinAll += all ? 1 : 0;
        dayHp += last;
      }
      return {
        slug,
        win: wins / seeds,
        ko: ko / seeds,
        hpWin: wins ? hp / wins : NaN,
        dayWinAll: dayWinAll / seeds,
        dayHp: dayHp / seeds,
      };
    });
    const mean = (f: (p: (typeof perClass)[number]) => number) => {
      const xs = perClass.map(f).filter((x) => !Number.isNaN(x));
      return xs.reduce((a, b) => a + b, 0) / xs.length;
    };
    return {
      id,
      level,
      label,
      monsters: ids.map((m) => m.replace('monster:', '')).join(','),
      win: mean((p) => p.win),
      ko: mean((p) => p.ko),
      hpWin: mean((p) => p.hpWin),
      dayWinAll: mean((p) => p.dayWinAll),
      dayHp: mean((p) => p.dayHp),
      perClass: perClass.map((p) => ({ slug: p.slug, win: +p.win.toFixed(3) })),
    };
  },
);
console.log(JSON.stringify({ seeds, rows }, null, 1));
