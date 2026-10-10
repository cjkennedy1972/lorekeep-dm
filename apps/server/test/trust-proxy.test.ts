import { describe, expect, it } from 'vitest';
import { parseTrustProxy } from '../src/config.js';

describe('TRUST_PROXY parsing', () => {
  it('keeps true and false as booleans', () => {
    expect(parseTrustProxy('true')).toBe(true);
    expect(parseTrustProxy('false')).toBe(false);
  });
  it('reads digits as a hop count, where 0 trusts nothing', () => {
    expect(parseTrustProxy('1')).toBe(1);
    expect(parseTrustProxy('2')).toBe(2);
    expect(parseTrustProxy('0')).toBe(false);
  });
  it('reads a comma-separated list as trusted proxy addresses or CIDRs', () => {
    expect(parseTrustProxy('10.0.0.0/8, 127.0.0.1')).toEqual([
      '10.0.0.0/8',
      '127.0.0.1',
    ]);
    expect(parseTrustProxy('fd00::/8')).toEqual(['fd00::/8']);
  });
  it('rejects values that are none of the above', () => {
    expect(() => parseTrustProxy('yes please')).toThrow(/TRUST_PROXY/);
    expect(() => parseTrustProxy('10.0.0.0/99')).toThrow(/TRUST_PROXY/);
    expect(() => parseTrustProxy('')).toThrow(/TRUST_PROXY/);
  });
});
