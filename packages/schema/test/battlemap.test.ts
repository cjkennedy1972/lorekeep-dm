import { describe, expect, test } from 'vitest';
import { rleDecode, rleEncode } from '../src/index.js';

describe('rle codec', () => {
  test('round-trips 200 random grids', () => {
    let s = 12345;
    const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
    for (let n = 0; n < 200; n++) {
      const len = 1 + Math.floor(rnd() * 3600);
      const k = 1 + Math.floor(rnd() * 8);
      const bias = rnd();
      const grid: number[] = [];
      for (let i = 0; i < len; i++) {
        grid.push(i > 0 && rnd() < bias ? grid[i - 1]! : Math.floor(rnd() * k));
      }
      expect(rleDecode(rleEncode(grid))).toEqual(grid);
    }
    expect(rleEncode([])).toEqual([]);
  });
});
