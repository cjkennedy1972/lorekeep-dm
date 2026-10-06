import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { contrast } from './contrast';

const tokens = readFileSync('src/styles/tokens.css', 'utf8');

/** Custom properties declared by every block whose selector matches `sel` exactly (comma list aware). */
function vars(sel: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [, selectors, body] of tokens.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!selectors!.split(',').some((s) => s.trim() === sel)) continue;
    for (const [, k, v] of body!.matchAll(/(--[\w-]+):\s*(#[0-9a-f]{6})\s*;/gi))
      out[k!] = v!;
  }
  return out;
}

const TEXT = 4.5;
const GRAPHIC = 3;
const textPairs: [string, string][] = [
  ['--fg', '--bg'],
  ['--fg', '--surface'],
  ['--fg-muted', '--bg'],
  ['--fg-muted', '--surface'],
  ['--accent', '--bg'],
  ['--accent', '--surface'],
  ['--danger', '--bg'],
  ['--success', '--bg'],
  ['--on-accent', '--accent'],
];
const graphicPairs: [string, string][] = [
  ['--border-ui', '--bg'],
  ['--focus', '--bg'],
  ['--focus', '--surface'],
  ['--accent', '--bg'],
];

describe.each([
  ['light', {}],
  ['dark', {}],
  ['light', { palette: 'cvd' }],
  ['dark', { palette: 'cvd' }],
] as const)('%s %o', (theme, opt) => {
  const palette = 'palette' in opt;
  const v = {
    ...(theme === 'light' ? vars(':root') : {}),
    ...vars(`[data-theme='${theme}']`),
    ...(palette ? vars(`[data-theme='${theme}'][data-palette='cvd']`) : {}),
  };
  test.each(textPairs)('text %s on %s >= 4.5:1', (fg, bg) => {
    expect(v[fg], fg).toBeDefined();
    expect(contrast(v[fg]!, v[bg]!)).toBeGreaterThanOrEqual(TEXT);
  });
  test.each(graphicPairs)('graphic %s on %s >= 3:1', (fg, bg) => {
    expect(contrast(v[fg]!, v[bg]!)).toBeGreaterThanOrEqual(GRAPHIC);
  });
});

test('contrast helper: black/white is 21:1 and a failing pair is detected', () => {
  expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5);
  expect(contrast('#777777', '#888888')).toBeLessThan(TEXT);
});

test('prefers-reduced-motion block disables transitions and animations', () => {
  const m =
    /@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?\})\s*\}/.exec(
      tokens,
    );
  expect(m?.[1]).toMatch(/transition:\s*none\s*!important/);
  expect(m?.[1]).toMatch(/animation:\s*none\s*!important/);
});
