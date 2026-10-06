import { expect, it } from 'vitest';
import { validPassword } from '../../src/accounts/password.js';
import { forgotResponse } from '../../src/accounts/reset.js';
it('uses the signup password policy and a disclosure-free forgot response', () => {
  expect(validPassword('password123456')).toBe(false);
  expect(validPassword('a unique passphrase 123')).toBe(true);
  expect(forgotResponse).toEqual({});
});
