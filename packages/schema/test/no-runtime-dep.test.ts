import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

const root = join(import.meta.dirname, '..');

test('@game/schema has no runtime deps other than zod', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  expect(Object.keys(pkg.dependencies ?? {})).toEqual(['zod']);
  expect(pkg.peerDependencies ?? {}).toEqual({});
  expect(pkg.optionalDependencies ?? {}).toEqual({});
});

test('@game/schema src imports no workspace packages', () => {
  const dir = join(root, 'src');
  for (const f of readdirSync(dir, { recursive: true }).map(String)) {
    if (!f.endsWith('.ts')) continue;
    expect(readFileSync(join(dir, f), 'utf8'), f).not.toMatch(/@game\//);
  }
});
