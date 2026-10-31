import { describe, expect, test } from 'vitest';
import { castableSlotLevels, defaultSlotLevel } from './slotLevels.js';

const slot = (max: number, used = 0) => ({ max, used });

describe('castableSlotLevels', () => {
  test('lists cantrip level 0 first, then each leveled slot with uses left', () => {
    expect(
      castableSlotLevels({ '1': slot(4, 1), '2': slot(3), '3': slot(2, 2) }),
    ).toEqual([0, 1, 2]);
  });

  test('offers only the cantrip choice when no slots are known', () => {
    expect(castableSlotLevels(undefined)).toEqual([0]);
    expect(castableSlotLevels({})).toEqual([0]);
  });

  test('skips fully spent slots', () => {
    expect(castableSlotLevels({ '1': slot(2, 2), '4': slot(1) })).toEqual([
      0, 4,
    ]);
  });
});

describe('defaultSlotLevel', () => {
  test('defaults to the lowest leveled slot so the common case keeps casting at 1', () => {
    expect(defaultSlotLevel([0, 1, 2])).toBe(1);
  });

  test('falls back to the cantrip choice when no leveled slot is left', () => {
    expect(defaultSlotLevel([0])).toBe(0);
  });
});
