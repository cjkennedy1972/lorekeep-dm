import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');

// Runs the real M1-28 gate command in a child process and checks its own reported output.
describe('M1 exit criterion 1: geometry gate and property suite', () => {
  test('pnpm --filter @game/rules-engine test:geometry exits 0 with 100/100 and all properties passing', () => {
    const run = spawnSync(
      'pnpm',
      ['--filter', '@game/rules-engine', 'test:geometry'],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        env: { ...process.env, CI: '1', NO_COLOR: '1', FORCE_COLOR: '0' },
      },
    );
    const out = `${run.stdout}\n${run.stderr}`;
    expect(run.status, out).toBe(0);
    expect(out).toMatch(/Geometry gate: 100\/100 passing/);
    expect(out).toMatch(/Test Files\s+2 passed \(2\)/);
    expect(out).not.toMatch(/\d+ failed/);
  }, 180_000);
});
