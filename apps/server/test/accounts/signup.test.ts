import { describe, expect, it } from 'vitest';
import { validPassword } from '../../src/accounts/password.js';
import { signupSchema, signupResponse } from '../../src/accounts/signup.js';
import { checkAdult } from '../../src/accounts/age.js';
describe('signup validation', () => {
  it('rejects email addresses longer than the shared 254-character limit', () => {
    const overlongEmail = `${'a'.repeat(242)}@example.test`;
    expect(overlongEmail.length).toBe(255);
    expect(
      signupSchema.safeParse({
        email: overlongEmail,
        password: 'a-long-unique-password',
        displayName: 'X',
        birthdate: '2000-01-01',
        termsVersion: 'v1',
      }).success,
    ).toBe(false);
  });
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
