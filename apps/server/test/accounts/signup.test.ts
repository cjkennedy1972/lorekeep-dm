import { describe, expect, it } from 'vitest';
import { validPassword } from '../../src/accounts/password.js';
import { signupSchema, signupResponse } from '../../src/accounts/signup.js';
import { checkAdult } from '../../src/accounts/age.js';
describe('signup validation', () => {
  it('rejects common passwords and invalid input', () => {
    expect(validPassword('password123456')).toBe(false);
    expect(validPassword('a-long-unique-password')).toBe(true);
    expect(
      signupSchema.safeParse({
        email: 'x@example.test',
        password: 'a-long-unique-password',
        displayName: 'X',
        birthdate: '2000-01-01',
        termsVersion: 'v1',
      }).success,
    ).toBe(true);
    expect(checkAdult('2010-01-01', new Date('2026-10-06'))).toBe(false);
    expect(signupResponse).toEqual({
      message: 'If eligible, check your email for a verification link.',
    });
  });
});
