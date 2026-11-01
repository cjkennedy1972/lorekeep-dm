import { allowInputGate } from '../support/allowInputGate.js';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { hashPassword } from '../../src/accounts/password.js';
import { argonLimiter } from '../../src/accounts/login.js';

async function setup(trustProxy?: boolean | number) {
  const password_hash = await hashPassword('correct-password-1');
  const queries: string[] = [];
  const sender = { sendPasswordReset: vi.fn(async () => undefined) };
  const db = {
    connect: async () => ({
      query: async (sql: string) => {
        queries.push(sql);
        return { rows: [], rowCount: 1 };
      },
      release: () => undefined,
    }),
    query: async (sql: string, args: unknown[]) => {
      queries.push(sql);
      if (/UPDATE auth_sessions/.test(sql))
        return { rows: [{ account_id: 'a' }], rowCount: 1 };
      if (/SELECT id FROM accounts WHERE email/.test(sql)) {
        const rows = args[0] === 'known@example.test' ? [{ id: 'a' }] : [];
        return { rows, rowCount: rows.length };
      }
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
  const app = createApp(db as never, {
    inputGate: allowInputGate,
    sender: sender as never,
    trustProxy,
  });
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
  const forgot = (email: string) =>
    app.inject({
      method: 'POST',
      url: '/api/password/forgot',
      payload: { email },
    });
  return { app, post, forgot, queries, sender };
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
    expect(untrusted.statusCode).toBe(429);
    expect(untrusted.json()).toEqual({
      code: 'BAD_CREDENTIALS',
      message: 'Email or password is incorrect.',
    });
    expect(timer).not.toHaveBeenCalled();

    timer.mockClear();
    const nextUntrusted = await post('known@example.test', ip(28));
    expect(nextUntrusted.statusCode).toBe(429);
    expect(nextUntrusted.headers['retry-after']).toBeDefined();
    expect(timer).not.toHaveBeenCalled();

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
  it('rejects a saturated network before consuming Argon2 capacity for another network', async () => {
    const { app, post } = await setup();
    const argonWork = vi.spyOn(argonLimiter, 'run');
    const sameNetwork = (last: number) => `203.0.113.${last}`;
    for (let i = 1; i <= 5; i++)
      await post('known@example.test', sameNetwork(i));
    const blocked = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        post('known@example.test', sameNetwork(i + 6)),
      ),
    );
    expect(blocked.every((response) => response.statusCode === 429)).toBe(true);
    expect(blocked.every((response) => response.headers['retry-after'])).toBe(
      true,
    );
    const otherNetwork = await post('known@example.test', '198.51.100.23');
    expect(otherNetwork.statusCode).toBe(401);
    expect(argonWork).toHaveBeenCalledTimes(6);
    argonWork.mockRestore();
    await app.close();
  });
  it('applies a progressive account-wide Retry-After while trusted sessions retain recovery access', async () => {
    const { app, post, forgot } = await setup();
    for (let i = 0; i < 100; i++) {
      const ip = `198.${(i >> 8) + 20}.${i & 255}.1`;
      expect((await post('known@example.test', ip)).statusCode).toBe(401);
    }
    const limited = [];
    for (let i = 1; i <= 8; i++)
      limited.push(await post('known@example.test', `100.${i}.1.1`));
    expect(limited.every((response) => response.statusCode === 429)).toBe(true);
    expect(Number(limited.at(-1)?.headers['retry-after'])).toBe(30);
    expect(limited[0]?.json()).toEqual({
      code: 'BAD_CREDENTIALS',
      message: 'Email or password is incorrect.',
    });
    expect((await forgot('known@example.test')).statusCode).toBe(202);
    const trusted = await post(
      'known@example.test',
      '100.9.1.1',
      'correct-password-1',
      'A'.repeat(43),
    );
    expect(trusted.statusCode).toBe(200);
    await app.close();
  });
  it('suppresses recovery sends for an hour without retiring the current reset token', async () => {
    const { app, forgot, queries, sender } = await setup();
    expect((await forgot('known@example.test')).statusCode).toBe(202);
    expect((await forgot('known@example.test')).statusCode).toBe(202);
    expect(
      queries.filter((sql) => /UPDATE email_tokens SET used_at/.test(sql)),
    ).toHaveLength(1);
    expect(
      queries.filter((sql) => /INSERT INTO email_tokens/.test(sql)),
    ).toHaveLength(1);
    expect(sender.sendPasswordReset).toHaveBeenCalledTimes(1);
    await app.close();
  });
  it('uses the trusted proxy client address for login buckets', async () => {
    const { app } = await setup(true);
    const attempt = (forwarded: string) =>
      app.inject({
        method: 'POST',
        url: '/api/login',
        remoteAddress: '10.0.0.1',
        headers: { 'x-forwarded-for': forwarded },
        payload: { email: 'known@example.test', password: 'wrong-password-1' },
      });
    for (let i = 0; i < 5; i++)
      expect((await attempt(`203.0.${i}.1`)).statusCode).toBe(401);
    const limited = await attempt('198.51.100.99');
    expect(limited.statusCode).toBe(429);
    await app.close();
  });
  it('rejects login request bodies above the configured limit', async () => {
    const { app } = await setup();
    const response = await app.inject({
      method: 'POST',
      url: '/api/login',
      payload: { email: 'a@example.test', password: 'x'.repeat(300 * 1024) },
    });
    expect(response.statusCode).toBe(413);
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
