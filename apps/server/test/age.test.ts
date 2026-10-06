import { describe, expect, test } from 'vitest';
import { checkAdult } from '../src/accounts/age.js';
import {
  attestAdult,
  isRetryBlocked,
  RETRY_BLOCK_TTL_SECONDS,
} from '../src/accounts/retryBlock.js';
import { readFileSync } from 'node:fs';

describe('UTC age gate', () => {
  test.each([
    ['exactly 18', '2008-10-06', '2026-10-06T00:00:00Z', true],
    ['one day short', '2008-10-07', '2026-10-06T23:59:59Z', false],
    ['timezone boundary', '2008-10-06', '2026-10-05T23:59:59-01:00', true],
    [
      'leap birthday before March 1',
      '2008-02-29',
      '2026-02-28T23:59:59Z',
      false,
    ],
    ['leap birthday March 1', '2008-02-29', '2026-03-01T00:00:00Z', true],
    ['leap birthday on leap year', '2004-02-29', '2024-02-29T00:00:00Z', true],
  ])('%s', (_label, birthdate, now, expected) => {
    expect(checkAdult(birthdate as string, new Date(now as string))).toBe(
      expected,
    );
  });
  test.each([
    '2026-10-07',
    'garbage',
    '2007-02-29',
    '2000-13-01',
    '0000-01-01',
    ' 2000-01-01',
  ])('rejects invalid or future %s', (value) => {
    expect(() => checkAdult(value, new Date('2026-10-06T00:00:00Z'))).toThrow(
      RangeError,
    );
  });
  test('errors never echo input', () => {
    expect(() => checkAdult('secret-birthdate')).toThrow('Invalid date');
  });
});

test('refusal issues signed retry block, preventing changed answer until expiration', () => {
  const now = new Date('2026-10-06T12:00:00Z');
  const refused = attestAdult('2010-01-01', undefined, 'test-secret', now);
  expect(refused.allowed).toBe(false);
  if (refused.allowed || !refused.retryBlockCookie)
    throw new Error('missing retry block');
  expect(refused.retryBlockCookie).toContain('HttpOnly; Secure; SameSite=Lax');
  expect(refused.retryBlockCookie).not.toContain('2010-01-01');
  expect(isRetryBlocked(refused.retryBlockCookie, 'test-secret', now)).toBe(
    true,
  );
  expect(
    attestAdult('1980-01-01', refused.retryBlockCookie, 'test-secret', now),
  ).toEqual({ allowed: false });
  expect(isRetryBlocked(refused.retryBlockCookie, 'wrong-secret', now)).toBe(
    false,
  );
  expect(
    isRetryBlocked(
      refused.retryBlockCookie,
      'test-secret',
      new Date(now.getTime() + RETRY_BLOCK_TTL_SECONDS * 1000),
    ),
  ).toBe(false);
  const tampered = refused.retryBlockCookie.replace(/=(\d+)/, '=9999999999');
  expect(isRetryBlocked(tampered, 'test-secret', now)).toBe(false);
});

test('adult result contains only attestation metadata', () => {
  expect(
    attestAdult(
      '2000-01-01',
      undefined,
      'test-secret',
      new Date('2026-10-06T00:00:00Z'),
    ),
  ).toEqual({
    allowed: true,
    isAdult: true,
    ageCheckedAt: '2026-10-06T00:00:00.000Z',
  });
});

test('age module has no database or logger dependencies', () => {
  const source = readFileSync(
    new URL('../src/accounts/age.ts', import.meta.url),
    'utf8',
  );
  expect(source).not.toMatch(
    /\b(?:import|require)\b[^;]*(?:db|database|logger|log)\b/i,
  );
});
