import { describe, expect, test } from 'vitest';
import {
  cellDistance,
  distance,
  footprint,
  inReach,
  isBlocked,
  occupancyIndex,
  rangeBand,
  type DiagonalRule,
} from '../src/map/geometry.js';

// mulberry32, inline so the property tests need no extra dependency
function prng(seed: number) {
  let s = seed >>> 0;
  return (n: number) => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
  };
}

describe('cellDistance properties (5ft rule)', () => {
  const rule: DiagonalRule = '5ft';
  const rnd = prng(18);
  const cell = () => ({ x: rnd(40) - 20, y: rnd(40) - 20 });
  test('symmetric, zero on identity, triangle inequality (1000 random triples)', () => {
    for (let i = 0; i < 1000; i++) {
      const a = cell();
      const b = cell();
      const c = cell();
      expect(cellDistance(a, b, rule)).toBe(cellDistance(b, a, rule));
      expect(cellDistance(a, a, rule)).toBe(0);
      expect(cellDistance(a, c, rule)).toBeLessThanOrEqual(
        cellDistance(a, b, rule) + cellDistance(b, c, rule),
      );
    }
  });
});

describe('diagonal rule', () => {
  test('alternate stays symmetric (not a metric: parity is path dependent)', () => {
    const a = { x: 0, y: 0 };
    const b = { x: 7, y: 3 };
    expect(cellDistance(a, b, 'alternate')).toBe(
      cellDistance(b, a, 'alternate'),
    );
  });
  const o = { x: 0, y: 0 };
  test.each([
    [{ x: 1, y: 0 }, 5, 5],
    [{ x: 1, y: 1 }, 5, 5],
    [{ x: 2, y: 2 }, 10, 15],
    [{ x: 4, y: 4 }, 20, 30],
    [{ x: 5, y: 2 }, 25, 30],
  ])('to %j: 5ft=%i alternate=%i', (to, a, b) => {
    expect(cellDistance(o, to, '5ft')).toBe(a);
    expect(cellDistance(o, to, 'alternate')).toBe(b);
  });
});

describe('footprint and occupancy', () => {
  const large = { id: 'ogre', pos: { x: 2, y: 2 }, size: 2 };
  test('Large (2x2) occupies exactly four cells', () => {
    expect(footprint(large)).toHaveLength(4);
    expect(occupancyIndex([large]).size).toBe(4);
  });
  test('Large blocks others but not itself', () => {
    const idx = occupancyIndex([large]);
    expect(isBlocked(idx, { pos: { x: 3, y: 3 }, size: 1 })).toBe(true);
    expect(isBlocked(idx, { pos: { x: 1, y: 2 }, size: 2 })).toBe(true);
    expect(isBlocked(idx, { pos: { x: 4, y: 2 }, size: 1 })).toBe(false);
    expect(isBlocked(idx, { pos: { x: 3, y: 2 }, size: 2 }, 'ogre')).toBe(
      false,
    );
  });
  test('adjacent footprints are 5 ft apart; reach follows', () => {
    const pc = { pos: { x: 4, y: 3 }, size: 1 };
    expect(distance(large, pc)).toBe(5);
    expect(inReach(pc, large)).toBe(true);
    expect(inReach({ pos: { x: 5, y: 3 }, size: 1 }, large)).toBe(false);
    expect(inReach({ pos: { x: 5, y: 3 }, size: 1 }, large, 10)).toBe(true);
  });
});

describe('rangeBand (normal 80 / long 320)', () => {
  test.each([
    [0, 'normal'],
    [80, 'normal'],
    [85, 'long'],
    [320, 'long'],
    [325, 'out'],
  ])('%i ft -> %s', (d, band) => {
    expect(rangeBand(d, 80, 320)).toBe(band);
  });
  test('no long range: beyond normal is out', () => {
    expect(rangeBand(35, 30)).toBe('out');
  });
});
