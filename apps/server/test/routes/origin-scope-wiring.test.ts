import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const appSource = readFileSync(
  fileURLToPath(new URL('../../src/app.ts', import.meta.url)),
  'utf8',
);

describe('route modules are registered only inside originScope', () => {
  const routeCalls = [...appSource.matchAll(/register\w+Routes\(\s*(\w+)/g)];

  it('registers at least one route module', () => {
    expect(routeCalls.length).toBeGreaterThan(0);
  });

  it('never passes the root app directly to a route module', () => {
    const direct = routeCalls.filter(([, arg]) => arg === 'app');
    expect(direct.map(([call]) => call)).toEqual([]);
  });

  it('passes every route module the scope handed to an originScope callback', () => {
    const scopedCalls = [
      ...appSource.matchAll(/originScope\(app,\s*\(scope\)\s*=>\s*register\w+Routes\(\s*scope\b/g),
    ];
    expect(scopedCalls.length).toBe(routeCalls.length);
  });
});
