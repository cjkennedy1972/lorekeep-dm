/**
 * Deterministic PRNG (mulberry32).
 * State is a uint32; every call returns the next state.
 *
 * **Important:** This RNG is NOT cryptographically secure.
 * It is designed for deterministic replay (e.g., dice rolls that must be reproducible).
 * Do NOT use for security-sensitive applications.
 *
 * Seeds must be:
 * - Integers only (rejects NaN, floats, Infinity, -Infinity)
 * - In the range [0, 2^32-1]
 * - Non-negative (negative values are rejected)
 *
 * Seeds are kept private until rolls are resolved to maintain determinism.
 */
export type RngState = number;

/**
 * Seed the RNG with a uint32 value.
 *
 * @param seed - Must be an integer in [0, 2^32-1]
 * @throws {TypeError} If seed is not an integer, is NaN, or is out of uint32 range
 */
export function seedRng(seed: number): RngState {
  // Validate seed is an integer
  if (!Number.isInteger(seed)) {
    throw new TypeError(`RNG seed must be an integer, got: ${seed}`);
  }

  // Validate seed is in uint32 range [0, 2^32-1]
  // Using bitwise operations which only work on uint32
  const normalized = seed >>> 0;

  // Check if the original seed would produce the same result
  // This ensures we reject values that would overflow or be negative
  if (seed < 0 || seed > 0xffffffff || normalized !== seed >>> 0) {
    // For negative numbers, the >>> operator converts them
    // We detect this by checking if the original was negative
    if (seed < 0) {
      throw new TypeError(`RNG seed must be non-negative, got: ${seed}`);
    }
    // For values > 2^32-1, we also reject them
    if (seed > 0xffffffff) {
      throw new TypeError(
        `RNG seed must be <= 2^32-1 (4294967295), got: ${seed}`,
      );
    }
  }

  return normalized;
}

/** Next float in [0,1) plus the next state. */
export function nextFloat(state: RngState): [number, RngState] {
  const next = (state + 0x6d2b79f5) >>> 0;
  let t = next;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return [((t ^ (t >>> 14)) >>> 0) / 4294967296, next];
}

/** Integer in [1, sides]. */
export function nextDie(state: RngState, sides: number): [number, RngState] {
  const [f, next] = nextFloat(state);
  return [Math.floor(f * sides) + 1, next];
}
