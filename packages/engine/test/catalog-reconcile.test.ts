import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const script = fileURLToPath(
  new URL('../../../scripts/catalog-reconcile.mjs', import.meta.url),
);
const realCatalog = fileURLToPath(new URL('../catalog', import.meta.url));

type Row = { name: string; [k: string]: unknown };
type Diff = {
  summary: Record<string, { srd: number; catalog: number; missing: number }>;
  kinds: Record<string, { missing: string[]; extra: string[] }>;
  statMismatches: { kind: string; entry: string; field: string }[];
};
function run(catalogDir: string) {
  const r = spawnSync(
    process.execPath,
    [script, '--json', '--catalog', catalogDir],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  return { status: r.status, diff: JSON.parse(r.stdout) as Diff };
}

describe('catalog reconciliation against SRD 5.2.1 (M2-03)', () => {
  const real = run(realCatalog);

  test('report covers every kind, compares the shipped catalog', () => {
    expect(Object.keys(real.diff.summary).sort()).toEqual([
      'background',
      'class',
      'condition',
      'equipment:armor',
      'equipment:gear-and-tools',
      'equipment:weapon',
      'monster',
      'species',
      'spell',
      'subclass',
    ]);
    expect(real.diff.summary.monster?.srd).toBe(242);
    expect(real.diff.summary.spell?.srd).toBe(183);
  });

  // Flips to a failure (and must then be changed to a plain test) once M2-04 closes the gap.
  test.fails('shipped catalog has no SRD entries missing (M2-04)', () => {
    expect(real.status).toBe(0);
  });

  test('detects a deleted spell, a changed monster hp and a renamed weapon', () => {
    const dir = mkdtempSync(join(tmpdir(), 'catalog-reconcile-'));
    cpSync(realCatalog, dir, { recursive: true });
    const edit = (file: string, fn: (rows: Row[]) => Row[]) => {
      const p = join(dir, file);
      writeFileSync(p, JSON.stringify(fn(JSON.parse(readFileSync(p, 'utf8')))));
    };
    edit('spells.json', (r) => r.filter((e) => e.name !== 'Fireball'));
    edit('monsters-low.json', (r) =>
      r.map((e) => (e.name === 'Animated Armor' ? { ...e, hp: 99 } : e)),
    );
    edit('equipment.json', (r) =>
      r.map((e) => (e.name === 'Longsword' ? { ...e, name: 'Longswurd' } : e)),
    );
    const { status, diff } = run(dir);
    expect(status).toBe(1);
    expect(diff.kinds.spell?.missing).toContain('Fireball');
    expect(diff.kinds['equipment:weapon']?.missing).toContain('Longsword');
    expect(diff.kinds['equipment:weapon']?.extra).toContain('Longswurd');
    expect(
      diff.statMismatches.some(
        (m) => m.entry === 'Animated Armor' && m.field === 'hp',
      ),
    ).toBe(true);
  });
});
