import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { contrast } from './contrast';
import { MAP_PALETTE } from '../features/map/Canvas2DRenderer';

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
  // Lantern palette: card and inset surfaces, verdigris secondary, status colors on cards.
  ['--fg', '--surface-2'],
  ['--fg-muted', '--surface-2'],
  ['--accent', '--surface-2'],
  ['--verdigris', '--bg'],
  ['--verdigris', '--surface'],
  ['--verdigris', '--surface-2'],
  ['--danger', '--surface'],
  ['--danger', '--surface-2'],
  ['--success', '--surface'],
];
const graphicPairs: [string, string][] = [
  ['--border-ui', '--bg'],
  ['--focus', '--bg'],
  ['--focus', '--surface'],
  ['--accent', '--bg'],
  ['--border-ui', '--surface'],
  ['--border-ui', '--surface-2'],
  ['--focus', '--surface-2'],
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

test('dark is the default theme and light is a data-theme override', () => {
  // :root shares its block with the dark theme, so an unthemed page renders dark.
  expect(tokens).toMatch(/:root,\s*\[data-theme='dark'\]\s*\{/);
  expect(vars("[data-theme='light']")['--bg']).not.toBe(
    vars("[data-theme='dark']")['--bg'],
  );
});

test('prefers-reduced-motion block disables transitions and animations', () => {
  const m =
    /@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?\})\s*\}/.exec(
      tokens,
    );
  expect(m?.[1]).toMatch(/transition:\s*none\s*!important/);
  expect(m?.[1]).toMatch(/animation:\s*none\s*!important/);
});

/** Blends `ink` at `alpha` over `base`, like the canvas does for pattern and grid strokes. */
function blend(ink: string, alpha: number, base: string): string {
  const n = (hex: string, shift: number) =>
    (Number.parseInt(hex.slice(1), 16) >> shift) & 255;
  const mix = (shift: number) =>
    Math.round(n(ink, shift) * alpha + n(base, shift) * (1 - alpha));
  return `#${[16, 8, 0].map((shift) => mix(shift).toString(16).padStart(2, '0')).join('')}`;
}

describe('map canvas palette (dark ink and parchment, used in both themes)', () => {
  const P = MAP_PALETTE;
  const graphics: [string, string, string][] = [
    ['wall edge on floor', P.edgeWall, P.floor],
    ['door edge on floor', P.edgeDoor, P.floor],
    ['window edge on floor', P.edgeWindow, P.floor],
    ['feature outline on floor', P.feature, P.floor],
    ['marker dot on floor', P.markerFill, P.floor],
    ['party token on floor', P.tokenParty, P.floor],
    ['foe token on floor', P.tokenFoe, P.floor],
    ['neutral token on floor', P.tokenOther, P.floor],
    ['active ring on floor', P.activeRing, P.floor],
    ['active outer ring on floor', P.activeRingOuter, P.floor],
    ['keyboard cursor on floor', P.cursor, P.floor],
    ['active ring on rubble', P.activeRing, P.rubble],
    ['keyboard cursor on rubble', P.cursor, P.rubble],
    ['pillar on floor', P.pillar, P.floor],
    [
      'pattern strokes on floor',
      blend(P.patternInk, P.patternAlpha, P.floor),
      P.floor,
    ],
    [
      'pattern strokes on rubble',
      blend(P.patternInk, P.patternAlpha, P.rubble),
      P.rubble,
    ],
    [
      'pattern strokes on wall',
      blend(P.patternInk, P.patternAlpha, P.wall),
      P.wall,
    ],
    ['wall edge on wall fill', P.edgeWall, P.wall],
  ];
  test.each(graphics)('%s >= 3:1', (_label, fg, bg) => {
    expect(contrast(fg, bg)).toBeGreaterThanOrEqual(GRAPHIC);
  });
  test.each([
    ['token initials on party token', P.tokenInk, P.tokenParty],
    ['token initials on foe token', P.tokenInk, P.tokenFoe],
    ['token initials on neutral token', P.tokenInk, P.tokenOther],
    ['marker label on its dark halo', P.markerText, P.markerStroke],
  ])('text: %s >= 4.5:1', (_label, fg, bg) => {
    expect(contrast(fg, bg)).toBeGreaterThanOrEqual(TEXT);
  });
});
