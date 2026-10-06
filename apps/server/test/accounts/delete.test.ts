import { describe, expect, it } from 'vitest';
import { DeleteAccountInputSchema } from '@game/schema';
import { authenticate } from '../../src/accounts/login.js';
import { hashPassword } from '../../src/accounts/password.js';

describe('account deletion', () => {
  it('requires the exact confirmation phrase', () => {
    expect(
      DeleteAccountInputSchema.safeParse({
        password: 'pass',
        confirmation: 'delete my account',
      }).success,
    ).toBe(false);
  });
  it('refuses login to a deleting account', async () => {
    const password_hash = await hashPassword('correct-password');
    const db = {
      query: async () => ({ rows: [{ password_hash, status: 'deleting' }] }),
    };
    expect(
      (await authenticate(db as never, 'test@example.test', 'correct-password'))
        .kind,
    ).toBe('deleting');
  });
});
