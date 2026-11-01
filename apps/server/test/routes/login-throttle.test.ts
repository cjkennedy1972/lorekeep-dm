import { allowInputGate } from '../support/allowInputGate.js';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import * as password from '../../src/accounts/password.js';
import { hashPassword } from '../../src/accounts/password.js';
import { argonLimiter } from '../../src/accounts/login.js';
import { BusyError } from '../../src/accounts/throttle.js';

async function setup(trustProxy?: boolean | number, rateLimit = 5) {
  const password_hash = await hashPassword('correct-password-1');
  const queries: string[] = [];
  const sender = { sendPasswordReset: vi.fn(async () => undefined) };
  const db = {
    connect: async () => ({
      query: async (sql: string) => {
        queries.push(sql);
        if (/SELECT 1 FROM email_tokens/.test(sql))
          return { rows: [{ id: 'live-reset-token' }], rowCount: 1 };
        return { rows: [], rowCount: 1 };
      },
      release: () => undefined,
    }),
    query: async (sql: string, args: unknown[]) => {
      queries.push(sql);
      if (/UPDATE auth_sessions/.test(sql))
        return { rows: [{ account_id: 'a' }], rowCount: 1 };
      if (/SELECT id FROM accounts WHERE email/.test(sql)) {
        const rows =
          typeof args[0] === 'string' && args[0].endsWith('@example.test')
            ? [{ id: args[0] === 'known@example.test' ? 'a' : args[0] }]
            : [];
        return { rows, rowCount: rows.length };
      }
      if (/INSERT INTO auth_sessions/.test(sql))
        return { rows: [], rowCount: 1 };
      if (/FROM accounts WHERE email/.test(sql)) {
        return {
          rows:
            typeof args[0] === 'string' && args[0].endsWith('@example.test')
              ? [
                  {
                    id: args[0] === 'known@example.test' ? 'a' : args[0],
                    email: args[0],
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
    rateLimit,
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
  it('does not let one account-network bucket block another network before the account ceiling', async () => {
    const { app, post } = await setup();
    for (let i = 1; i <= 5; i++)
      await post('known@example.test', `203.0.113.${i}`);
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
  it('checks credentials for an account at the recovery ceiling', async () => {
    const { app, post, sender } = await setup();
    for (let i = 0; i < 10; i++) {
      const response = await post('known@example.test', `198.${i}.0.1`);
      expect(response.statusCode).toBe(401);
    }
    const verify = vi.spyOn(password, 'verifyPassword');
    const owner = await post(
      'known@example.test',
      '192.0.1.1',
      'correct-password-1',
    );
    expect(owner.statusCode).toBe(200);
    expect(verify).toHaveBeenCalled();
    expect(sender.sendPasswordReset).not.toHaveBeenCalled();
    verify.mockRestore();
    await app.close();
  });
  it('allows the owner to log in after the account failure window expires', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { app, post } = await setup();
    try {
      for (let i = 0; i < 10; i++)
        expect(
          (await post('known@example.test', `198.${i}.1.1`)).statusCode,
        ).toBe(401);
      vi.advanceTimersByTime(600_001);
      expect(
        (await post('known@example.test', '192.0.1.1', 'correct-password-1'))
          .statusCode,
      ).toBe(200);
    } finally {
      vi.useRealTimers();
      await app.close();
    }
  });
  it('does not retire a live reset link when automatic recovery is triggered', async () => {
    const { app, post, queries, sender } = await setup();
    for (let i = 0; i < 10; i++) {
      const response = await post('known@example.test', `198.${i}.1.1`);
      expect(response.statusCode).toBe(401);
    }
    await vi.waitFor(() =>
      expect(
        queries.some((sql) => /SELECT 1 FROM email_tokens/.test(sql)),
      ).toBe(true),
    );
    expect(sender.sendPasswordReset).not.toHaveBeenCalled();
    expect(
      queries.some((sql) => /UPDATE email_tokens SET used_at/.test(sql)),
    ).toBe(false);
    await app.close();
  });
  it('reserves Argon2 capacity across accounts from one IPv6 /64', async () => {
    const { app, post } = await setup();
    let active = 0;
    let releaseWork!: () => void;
    const workGate = new Promise<void>((resolve) => {
      releaseWork = resolve;
    });
    let signalThreeActive!: () => void;
    const threeActive = new Promise<void>((resolve) => {
      signalThreeActive = resolve;
    });
    const run = vi
      .spyOn(argonLimiter, 'run')
      .mockImplementation(async <T>(work: () => Promise<T>): Promise<T> => {
        if (active >= 4) throw new BusyError('busy');
        active++;
        if (active === 3) signalThreeActive();
        try {
          await workGate;
          return await work();
        } finally {
          active--;
        }
      });
    const attacker = Array.from({ length: 8 }, (_, i) =>
      post(
        `spray-${i}@example.test`,
        `2001:db8:abcd:${(i + 1).toString(16)}::1`,
      ),
    );
    try {
      await threeActive;
      const owner = post(
        'known@example.test',
        '2001:db8:ffff:34::1',
        'correct-password-1',
      );
      await vi.waitFor(() => expect(active).toBe(4));
      releaseWork();
      const [ownerResponse, ...attackerResponses] = await Promise.all([
        owner,
        ...attacker,
      ]);
      expect(ownerResponse.statusCode).toBe(200);
      expect(
        attackerResponses.filter((response) => response.statusCode === 429)
          .length,
      ).toBeGreaterThan(0);
      expect(
        attackerResponses.every((response) => response.statusCode !== 503),
      ).toBe(true);
    } finally {
      releaseWork();
      run.mockRestore();
      await app.close();
    }
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

  it('rejects overlong emails consistently on forgot and resend', async () => {
    const { app } = await setup();
    const email = `${'a'.repeat(242)}@example.test`;
    expect(email.length).toBe(255);
    const forgot = await app.inject({
      method: 'POST',
      url: '/api/password/forgot',
      payload: { email },
    });
    const resend = await app.inject({
      method: 'POST',
      url: '/api/verify-email/resend',
      payload: { email },
    });
    expect(forgot.statusCode).toBe(400);
    expect(resend.statusCode).toBe(400);
    await app.close();
  });

  it('accepts a maximum-length valid email across login, forgot, and resend', async () => {
    const { app } = await setup();
    const email = `${'a'.repeat(241)}@example.test`;
    expect(email.length).toBe(254);
    const login = await app.inject({
      method: 'POST',
      url: '/api/login',
      payload: { email, password: 'wrong-password-1' },
    });
    const forgot = await app.inject({
      method: 'POST',
      url: '/api/password/forgot',
      payload: { email },
    });
    const resend = await app.inject({
      method: 'POST',
      url: '/api/verify-email/resend',
      payload: { email },
    });
    expect(login.statusCode).toBe(401);
    expect(forgot.statusCode).toBe(202);
    expect(resend.statusCode).toBe(202);
    await app.close();
  });

  it('uses the trusted proxy client-IP helper for recovery, reset, and resend limits', async () => {
    const { app } = await setup(true);
    const clientIp = vi.spyOn(app, 'clientIpForUpgrade');
    const inject = (url: string, payload: unknown) =>
      app.inject({
        method: 'POST',
        url,
        remoteAddress: '10.0.0.1',
        headers: { 'x-forwarded-for': '203.0.113.77' },
        payload,
      });

    expect(
      (await inject('/api/password/forgot', { email: 'a@example.test' }))
        .statusCode,
    ).toBe(202);
    expect(
      (
        await inject('/api/password/reset', {
          token: 'invalid',
          password: 'a-long-unique-password',
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await inject('/api/verify-email/resend', { email: 'b@example.test' }))
        .statusCode,
    ).toBe(202);
    expect(clientIp).toHaveBeenCalledTimes(3);
    expect(clientIp).toHaveBeenCalledWith(
      expect.objectContaining({ headers: expect.any(Object) }),
    );
    await app.close();
  });
  it('does not let X-Forwarded-For rotation bypass login throttling with TRUST_PROXY=true', async () => {
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
    expect((await attempt('198.51.100.99')).statusCode).toBe(429);
    await app.close();
  });
  it('uses the proxy-appended address for login buckets with one trusted hop', async () => {
    const { app } = await setup(1);
    const attempt = (client: string, proxyClient: string) =>
      app.inject({
        method: 'POST',
        url: '/api/login',
        remoteAddress: '10.0.0.1',
        headers: { 'x-forwarded-for': `${client}, ${proxyClient}` },
        payload: { email: 'known@example.test', password: 'wrong-password-1' },
      });
    for (let i = 0; i < 5; i++)
      expect((await attempt(`203.0.${i}.1`, '198.51.100.23')).statusCode).toBe(
        401,
      );
    expect((await attempt('198.51.100.99', '198.51.100.23')).statusCode).toBe(
      429,
    );
    expect((await attempt('198.51.100.99', '192.0.2.24')).statusCode).toBe(401);
    await app.close();
  });
  it('expires network and IP login locks after their fixed window', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { app, post } = await setup();
    try {
      for (let i = 1; i <= 5; i++)
        expect(
          (await post('known@example.test', `203.0.113.${i}`)).statusCode,
        ).toBe(401);
      const locked = await post('known@example.test', '203.0.113.6');
      expect(locked.statusCode).toBe(429);
      expect(locked.headers['retry-after']).toBe('600');
      vi.advanceTimersByTime(600_001);
      expect(
        (await post('known@example.test', '203.0.113.6', 'correct-password-1'))
          .statusCode,
      ).toBe(200);
    } finally {
      vi.useRealTimers();
      await app.close();
    }
  });
  it('expires the IP login lock after its fixed window', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { app, post } = await setup();
    try {
      for (let i = 0; i < 20; i++)
        expect(
          (await post(`attacker${i}@example.test`, '198.51.100.70')).statusCode,
        ).toBe(401);
      const locked = await post('owner@example.test', '198.51.100.70');
      expect(locked.statusCode).toBe(429);
      expect(locked.headers['retry-after']).toBe('600');
      vi.advanceTimersByTime(600_001);
      expect(
        (
          await post(
            'owner@example.test',
            '198.51.100.70',
            'correct-password-1',
          )
        ).statusCode,
      ).toBe(200);
    } finally {
      vi.useRealTimers();
      await app.close();
    }
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
