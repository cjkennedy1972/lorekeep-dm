import { allowInputGate } from '../support/allowInputGate.js';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { hashPassword } from '../../src/accounts/password.js';

async function setup() {
  const password_hash = await hashPassword('correct-password-1');
  const db = {
    connect: async () => undefined,
    query: async (sql: string, args: unknown[]) => {
      if (/UPDATE auth_sessions/.test(sql))
        return { rows: [{ account_id: 'a' }], rowCount: 1 };
      if (/SELECT id FROM accounts WHERE email/.test(sql))
        return { rows: args[0] === 'known@example.test' ? [{ id: 'a' }] : [] };
      if (/INSERT INTO auth_sessions/.test(sql))
        return { rows: [], rowCount: 1 };
      if (/FROM accounts WHERE email/.test(sql)) {
        return {
          rows:
            args[0] === 'known@example.test'
              ? [
                  {
                    id: 'a',
                    email: 'known@example.test',
                    password_hash,
                    status: 'active',
                    is_adult: true,
                    age_checked_at: new Date('2026-01-01T00:00:00.000Z'),
                    display_name: 'Player',
                  },
                ]
              : [],
        };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  const app = createApp(db as never, { inputGate: allowInputGate });
  const post = (
    email: string,
    ip: string,
    password = 'wrong-password-1',
    cookie?: string,
  ) =>
    app.inject({
      method: 'POST',
      url: '/api/login',
      remoteAddress: ip,
      headers: cookie ? { cookie: `sid=${cookie}` } : undefined,
      payload: { email, password },
    });
  return { app, post };
}

describe('login throttle', () => {
  it('does not let failures from an attacker IP block the owner on another IP', async () => {
    const { app, post } = await setup();
    for (let i = 0; i < 10; i++)
      await post('known@example.test', `203.0.${i}.9`);
    const ownerLogin = await post(
      'known@example.test',
      '198.51.100.7',
      'correct-password-1',
    );
    expect(ownerLogin.statusCode).toBe(200);
    await app.close();
  });
  it('lets the same account’s trusted session bypass account-network backoff', async () => {
    const { app, post } = await setup();
    const ip = (last: number) => `198.51.100.${last}`;
    for (let i = 21; i < 26; i++)
      expect((await post('known@example.test', ip(i))).statusCode).toBe(401);
    const timer = vi.spyOn(globalThis, 'setTimeout');
    const untrusted = await post('known@example.test', ip(26));
    expect(untrusted.statusCode).toBe(401);
    expect(untrusted.json()).toEqual({
      code: 'BAD_CREDENTIALS',
      message: 'Email or password is incorrect.',
    });
    expect(timer).toHaveBeenCalledWith(expect.any(Function), 250);

    timer.mockClear();
    const nextUntrusted = await post('known@example.test', ip(28));
    expect(nextUntrusted.statusCode).toBe(401);
    expect(timer).toHaveBeenCalledWith(expect.any(Function), 500);

    timer.mockClear();
    const trustedCookie = 'A'.repeat(43);
    const trusted = await post(
      'known@example.test',
      ip(27),
      'wrong-password-1',
      trustedCookie,
    );
    expect(trusted.statusCode).toBe(401);
    expect(timer).not.toHaveBeenCalled();
    timer.mockRestore();
    await app.close();
  });
  it('unknown email and wrong password bodies are byte-identical', async () => {
    const { app, post } = await setup();
    const unknown = await post('nobody@example.test', '10.0.0.4');
    const wrong = await post('known@example.test', '10.0.0.4');
    expect(unknown.statusCode).toBe(401);
    expect(unknown.body).toBe(wrong.body);
    await app.close();
  });
});
