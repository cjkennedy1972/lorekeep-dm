import { randomBytes } from 'node:crypto';

const MASK_64 = (1n << 64n) - 1n;
const uint64 = (value: bigint | number | string): bigint => {
  const seed = typeof value === 'bigint' ? value : BigInt(value);
  if (seed < 0n || seed > MASK_64)
    throw new RangeError('seed must be an unsigned 64-bit integer');
  return seed;
};
/** Draw a cryptographically random per-turn seed; deterministic override is test-only. */
export function createTurnSeed(
  options: { testMode?: boolean; fixedSeed?: bigint | number | string } = {},
): bigint {
  if (options.fixedSeed !== undefined) {
    if (!options.testMode)
      throw new Error('fixed turn seeds are only permitted in test mode');
    return uint64(options.fixedSeed);
  }
  if (options.testMode) return 0n;
  return randomBytes(8).readBigUInt64BE();
}
function splitmix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & MASK_64;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK_64;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK_64;
  return (z ^ (z >> 31n)) & MASK_64;
}
/** Independent 64-bit starting state for a roll index, per ADR-022 §6.1. */
export function rollSeed(
  turnSeed: bigint | number | string,
  rollIndex: number,
): bigint {
  if (!Number.isSafeInteger(rollIndex) || rollIndex < 0)
    throw new RangeError('rollIndex must be a non-negative safe integer');
  return (uint64(turnSeed) ^ splitmix64(BigInt(rollIndex))) & MASK_64;
}
/** xoshiro256** state words derived deterministically from the per-roll seed. */
export function xoshiro256ssState(
  seed: bigint | number | string,
): readonly [bigint, bigint, bigint, bigint] {
  let value = uint64(seed);
  const words: bigint[] = [];
  for (let i = 0; i < 4; i++) {
    value = (value + 0x9e3779b97f4a7c15n) & MASK_64;
    let z = value;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK_64;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK_64;
    words.push((z ^ (z >> 31n)) & MASK_64);
  }
  return words as unknown as readonly [bigint, bigint, bigint, bigint];
}
export const formatTurnSeed = (seed: bigint | number | string): string =>
  `0x${uint64(seed).toString(16).padStart(16, '0')}`;
