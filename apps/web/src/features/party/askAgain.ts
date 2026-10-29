/** Mirrors the late-join limiter (routes/sessions.ts): 3 asks per 10 minutes, then 1 per 2 minutes. */
const WINDOW_MS = 10 * 60_000;
const BURST = 3;
const INTERVAL_MS = 2 * 60_000;

/** Milliseconds until another ask is allowed, given the times of earlier asks; 0 when allowed now. */
export function askAgainWaitMs(asks: readonly number[], now: number): number {
  const prior = asks.filter((at) => now - at < WINDOW_MS);
  if (prior.length < BURST) return 0;
  const last = prior[prior.length - 1]!;
  return Math.max(0, INTERVAL_MS - (now - last));
}
