import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import { loadCatalog } from '../catalog/load.js';
import { runCell, type CellRow, type CellSpec } from './sweep.js';

const keyOf = (s: CellSpec) =>
  [
    s.policy,
    s.level,
    s.classSlug,
    s.k,
    s.maxEnemies,
    s.label ?? 'moderate',
    s.seeds,
    s.seedBase,
    s.mode,
  ].join('|');

export function readRows(file: string): CellRow[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as CellRow);
}

/**
 * Run cells on a small worker pool, streaming each finished row to `out` (JSONL).
 * Cells already present in `out` are skipped, so an interrupted sweep resumes.
 */
export async function runPool(
  specs: CellSpec[],
  out: string,
  workers: number,
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  const have = new Set(readRows(out).map(keyOf));
  const todo = specs.filter((s) => !have.has(keyOf(s)));
  let done = 0;
  if (!todo.length) return;
  await new Promise<void>((resolve, reject) => {
    let next = 0;
    let live = Math.min(workers, todo.length);
    for (let w = 0; w < live; w++) {
      const worker = new Worker(new URL(import.meta.url));
      const feed = () => {
        if (next >= todo.length) {
          void worker.terminate();
          if (--live === 0) resolve();
          return;
        }
        worker.postMessage(todo[next++]);
      };
      worker.on('message', (row: CellRow) => {
        appendFileSync(out, `${JSON.stringify(row)}\n`);
        onProgress?.(++done, todo.length);
        feed();
      });
      worker.on('error', reject);
      feed();
    }
  });
}

if (!isMainThread && parentPort) {
  const catalog = loadCatalog();
  const port = parentPort;
  port.on('message', (spec: CellSpec) =>
    port.postMessage(runCell(catalog, spec)),
  );
}
