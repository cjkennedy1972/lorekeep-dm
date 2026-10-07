import { describe, expect, test } from 'vitest';
import { RleError, rleDecode, rleEncode } from '../src/index.js';

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

describe('rleDecode bounds', () => {
  const code = (rle: number[]) => {
    try {
      rleDecode(rle);
    } catch (e) {
      return e instanceof RleError ? e.code : 'other';
    }
    return 'none';
  };
  test('huge run rejected without allocating', () => {
    expect(code([0, 200_000_000])).toBe('RLE_TOO_LARGE');
  });
  test('negative, zero, odd rejected', () => {
    expect(code([0, -1])).toBe('RLE_BAD_RUN');
    expect(code([0, 0])).toBe('RLE_BAD_RUN');
    expect(code([0, 4, 1])).toBe('RLE_ODD_LENGTH');
  });
  test('max-size map still decodes', () => {
    expect(rleDecode([0, 3600])).toHaveLength(3600);
  });
});
