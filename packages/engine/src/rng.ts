/** Deterministic PRNG (mulberry32). State is a uint32; every call returns the next state. */
export type RngState = number;

export function seedRng(seed: number): RngState {
  return seed >>> 0;
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
