import { expect, it } from 'vitest';
import { hashToken } from '../../src/accounts/signup.js';
it('hashes verification tokens deterministically without retaining raw token', () => {
  const token = 'a'.repeat(43);
  expect(hashToken(token)).toHaveLength(64);
  expect(hashToken(token)).not.toContain(token);
});
