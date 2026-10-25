import { describe, expect, it } from 'vitest';
import {
  MAP_SYNC_BUDGET_MS,
  percentile,
  summarizeLatency,
} from '../e2e/latency-stats.js';

describe('latency stats', () => {
  it('uses nearest-rank percentiles', () => {
    const samples = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(percentile(samples, 50)).toBe(50);
    expect(percentile(samples, 95)).toBe(100);
    expect(percentile(samples, 100)).toBe(100);
  });

  it('counts samples over the 1 s map-sync budget', () => {
    const summary = summarizeLatency([120, 980, 1000, 1001, 1500]);
    expect(MAP_SYNC_BUDGET_MS).toBe(1000);
    expect(summary.overBudget).toBe(2);
    expect(summary.max).toBe(1500);
    expect(summary.count).toBe(5);
  });

  it('rejects empty samples and invalid percentiles', () => {
    expect(() => percentile([], 50)).toThrow(RangeError);
    expect(() => percentile([1], 101)).toThrow(RangeError);
  });
});
