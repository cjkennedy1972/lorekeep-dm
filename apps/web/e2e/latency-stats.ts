/** Map-sync budget from spec US-B4 AC4: a state change is visible within one second. */
export const MAP_SYNC_BUDGET_MS = 1000;

export interface LatencySummary {
  readonly count: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
  readonly budgetMs: number;
  readonly overBudget: number;
}

/** Nearest-rank percentile over samples in ms; p is 0-100. */
export function percentile(samples: readonly number[], p: number): number {
  if (samples.length === 0) throw new RangeError('No latency samples');
  if (!(p >= 0 && p <= 100)) throw new RangeError(`Invalid percentile ${p}`);
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1]!;
}

export function summarizeLatency(
  samples: readonly number[],
  budgetMs: number = MAP_SYNC_BUDGET_MS,
): LatencySummary {
  return {
    count: samples.length,
    p50: percentile(samples, 50),
    p95: percentile(samples, 95),
    max: percentile(samples, 100),
    budgetMs,
    overBudget: samples.filter((sample) => sample > budgetMs).length,
  };
}
