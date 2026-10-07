import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const src = resolve(dirname(fileURLToPath(import.meta.url)), '../src');
const IMPORT = /(?:from|import)\s*['"]([^'"]+)['"]/g;

// ADR-004: the main entrypoint must stay free of Node built-ins.
test('engine index and its transitive src imports use no node: modules', () => {
  const seen = new Set<string>();
  const bad: string[] = [];
  const visit = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const m of readFileSync(file, 'utf8').matchAll(IMPORT)) {
      const spec = m[1]!;
      if (spec.startsWith('node:')) bad.push(`${file}: ${spec}`);
      else if (spec.startsWith('.'))
        visit(resolve(dirname(file), spec.replace(/\.js$/, '.ts')));
    }
  };
  visit(resolve(src, 'index.ts'));
  expect(seen.size).toBeGreaterThan(3);
  expect(bad).toEqual([]);
});
