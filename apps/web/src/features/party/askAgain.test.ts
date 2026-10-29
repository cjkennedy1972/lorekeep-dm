import { describe, expect, test } from 'vitest';
import { askAgainWaitMs } from './askAgain';

const MIN = 60_000;

describe('askAgainWaitMs', () => {
  test('allows the first three asks in a 10-minute window immediately', () => {
    expect(askAgainWaitMs([], 0)).toBe(0);
    expect(askAgainWaitMs([0, 1], 2)).toBe(0);
  });

  test('after three asks, waits for the 2-minute interval since the last ask', () => {
    expect(askAgainWaitMs([0, 1, 2], 2 + 30_000)).toBe(90_000);
    expect(askAgainWaitMs([0, 1, 2], 2 + 2 * MIN)).toBe(0);
  });

  test('asks older than 10 minutes stop counting toward the burst', () => {
    expect(askAgainWaitMs([0, 1, 2], 10 * MIN + 5)).toBe(0);
  });
});
