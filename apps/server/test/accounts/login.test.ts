import { describe, expect, it } from 'vitest';
import { authenticate, badCredentials } from '../../src/accounts/login.js';
import { hashPassword } from '../../src/accounts/password.js';

describe('login', () => {
  it('uses identical failure contract for unknown email and wrong password', async () => {
    const password_hash = await hashPassword('correct-password');
    const db = {
      query: async (_sql: string, args: unknown[]) => ({
        rows:
          args[0] === 'known@example.com'
            ? [{ password_hash, status: 'active' }]
            : [],
      }),
    };
    const unknown = await authenticate(
      db as never,
      'missing@example.com',
      'wrong-password',
    );
    const wrong = await authenticate(
      db as never,
      'known@example.com',
      'wrong-password',
    );
    expect(unknown.kind).toBe('invalid');
    expect(wrong.kind).toBe('invalid');
    expect(JSON.stringify(badCredentials)).toBe(
      '{"code":"BAD_CREDENTIALS","message":"Email or password is incorrect."}',
    );
  });
  it('refuses unverified credentials with an actionable state', async () => {
    const password_hash = await hashPassword('correct-password');
    const db = {
      query: async () => ({
        rows: [{ password_hash, status: 'pending_email' }],
      }),
    };
    expect(
      (await authenticate(db as never, 'known@example.com', 'correct-password'))
        .kind,
    ).toBe('pending');
  });
});
