import { readFileSync, writeFileSync } from 'node:fs';
import { loadCatalog } from '../catalog/load.js';
import {
  encounterBudget,
  type EncounterDifficulty,
} from '../encounter/budget.js';
import { buildPc, CLASS_SLUGS } from './pc.js';
import { readRows } from './pool.js';
import { LABELS, TARGETS } from './select.js';
import { aggregate, type CellRow } from './sweep.js';

const pct = (x: number) =>
  Number.isNaN(x) ? 'n/a' : `${Math.round(x * 100)}%`;
const row = (...c: (string | number)[]) => `| ${c.join(' | ')} |`;
const head = (...c: string[]) => [row(...c), row(...c.map(() => '---'))];

type Table = {
  levels: Record<
    string,
    Record<string, { multiplier: number; maxEnemies?: number; met: boolean }>
  >;
};

const BEGIN = '<!-- generated:begin -->';
const END = '<!-- generated:end -->';

/** Markdown for the generated sections of solo-calibration.md (fully derived from the data files). */
export function renderTables(table: Table, verifyRows: readonly CellRow[]) {
  const sel = (p: string, mode: string, level: number, label?: string) =>
    verifyRows.filter(
      (r) =>
        r.policy === p &&
        r.mode === mode &&
        r.level === level &&
        (label === undefined || r.label === label),
    );
  const out: string[] = [];
  out.push('### Calibration table (what the builder loads)', '');
  out.push(
    ...head(
      'Level',
      'Label',
      'Multiplier (x SRD row)',
      'Enemy cap',
      'Absolute XP budget',
      'Fitted inside band?',
      'Held-out win (95% CI)',
      'Held-out HP lost in wins',
      'Held-out KO rate',
      'Avg enemies',
    ),
  );
  for (let level = 1; level <= 5; level++)
    for (const label of LABELS) {
      const c = table.levels[String(level)]![label]!;
      const a = aggregate(sel('v2', 'single', level, label));
      const budget = Math.floor(
        encounterBudget(level, 1, label as EncounterDifficulty) * c.multiplier +
          1e-9,
      );
      out.push(
        row(
          level,
          label,
          c.multiplier,
          c.maxEnemies ?? 'none',
          budget,
          c.met ? 'yes' : '**no**',
          `${pct(a.win)} (${pct(a.winLo)}–${pct(a.winHi)})`,
          pct(a.hpLostWin),
          pct(a.ko),
          a.enemies.toFixed(1),
        ),
      );
    }
  out.push('', '### Targets used (pending human approval)', '');
  out.push(...head('Label', 'Win rate', 'HP lost in won fights'));
  for (const label of LABELS) {
    const t = TARGETS[label];
    const win = t.winMax
      ? `${pct(t.winMin)}–${pct(t.winMax)}`
      : `≥ ${pct(t.winMin)}`;
    const hp =
      t.hpLostMin !== undefined && t.hpLostMax !== undefined
        ? `${pct(t.hpLostMin)}–${pct(t.hpLostMax)}`
        : t.hpLostMax !== undefined
          ? `< ${pct(t.hpLostMax)}`
          : 'unconstrained';
    out.push(row(label, win, hp));
  }
  out.push(
    '',
    '### Three encounters in a row (held-out seeds, same cells)',
    '',
  );
  out.push(
    ...head(
      'Level',
      'Label',
      'Won all 3, short rest between',
      'Won all 3, no rest',
      'HP lost after fight 3 (short rest)',
    ),
  );
  for (let level = 1; level <= 5; level++)
    for (const label of LABELS) {
      const s = aggregate(sel('v2', 'seq-short', level, label));
      const sr = sel('v2', 'seq-short', level, label);
      const wonAll =
        sr.reduce((x, r) => x + (r.wonAll ?? 0) / r.n, 0) / sr.length;
      const nr = sel('v2', 'seq-none', level, label);
      const wonAllN =
        nr.reduce((x, r) => x + (r.wonAll ?? 0) / r.n, 0) / nr.length;
      out.push(row(level, label, pct(wonAll), pct(wonAllN), pct(s.hpLostAll)));
    }
  out.push(
    '',
    '### Policy-quality sensitivity (single fight win rate, same encounters)',
    '',
  );
  out.push(
    ...head(
      'Level',
      'Label',
      'v0 (weapon only)',
      'v1 (default quick build + features)',
      'v2 (optimised spells, focus fire)',
    ),
  );
  for (let level = 1; level <= 5; level++)
    for (const label of LABELS)
      out.push(
        row(
          level,
          label,
          pct(aggregate(sel('v0', 'single', level, label)).win),
          pct(aggregate(sel('v1', 'single', level, label)).win),
          pct(aggregate(sel('v2', 'single', level, label)).win),
        ),
      );

  const catalog = loadCatalog();
  out.push(
    '',
    '### Per-class spread: win rate at the shipped moderate encounter (v2, held-out)',
    '',
  );
  out.push(
    ...head(
      'Class',
      ...[1, 2, 3, 4, 5].map((l) => `L${l} win`),
      'L1 HP/AC',
      'L5 HP/AC',
      'mean',
    ),
  );
  const perClass: { slug: string; mean: number }[] = [];
  for (const slug of CLASS_SLUGS) {
    const cells = [1, 2, 3, 4, 5].map((level) => {
      const r = sel('v2', 'single', level, 'moderate').find(
        (x) => x.classSlug === slug,
      )!;
      return r.wins / r.n;
    });
    const mean = cells.reduce((a, b) => a + b, 0) / cells.length;
    perClass.push({ slug, mean });
    const p1 = buildPc(catalog, `class:${slug}`, 1, 'v2');
    const p5 = buildPc(catalog, `class:${slug}`, 5, 'v2');
    out.push(
      row(
        slug,
        ...cells.map(pct),
        `${p1.maxHp}/${p1.spec.ac}`,
        `${p5.maxHp}/${p5.spec.ac}`,
        pct(mean),
      ),
    );
  }
  perClass.sort((a, b) => a.mean - b.mean);
  out.push(
    '',
    `Weakest three: ${perClass
      .slice(0, 3)
      .map((c) => `${c.slug} ${pct(c.mean)}`)
      .join(', ')}. ` +
      `Strongest three: ${perClass
        .slice(-3)
        .reverse()
        .map((c) => `${c.slug} ${pct(c.mean)}`)
        .join(', ')}.`,
  );
  return out.join('\n');
}

/** Replace the generated block of the report in place. */
export function writeReport(
  docPath: string,
  tablePath: string,
  verifyPath: string,
) {
  const table = JSON.parse(readFileSync(tablePath, 'utf8')) as Table;
  const md = renderTables(table, readRows(verifyPath));
  const doc = readFileSync(docPath, 'utf8');
  const a = doc.indexOf(BEGIN);
  const b = doc.indexOf(END);
  if (a < 0 || b < 0) throw new Error('report markers missing');
  writeFileSync(
    docPath,
    `${doc.slice(0, a + BEGIN.length)}\n\n${md}\n\n${doc.slice(b)}`,
  );
}
