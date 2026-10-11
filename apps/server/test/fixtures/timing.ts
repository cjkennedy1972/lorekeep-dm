/** Median wall time of `run` over `samples` timed calls, after one warm-up call. */
export function medianMs(run: () => void, samples = 5): number {
  run();
  const times = Array.from({ length: samples }, () => {
    const t0 = performance.now();
    run();
    return performance.now() - t0;
  }).sort((a, b) => a - b);
  return times[Math.floor(samples / 2)]!;
}
