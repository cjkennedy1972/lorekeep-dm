import { describe, expect, it } from 'vitest';
import { createApp, createLogger } from '../src/app.js';
import { loadConfig } from '../src/config.js';

describe('server app', () => {
  it('answers liveness and readiness', async () => {
    const app = createApp({ query: async () => ({ rows: [] }) } as never);
    expect((await app.inject('/healthz')).statusCode).toBe(200);
    expect((await app.inject('/readyz')).statusCode).toBe(200);
    await app.close();
  });
  it('returns an explicit refusal without touching the database, including retry-blocked adults', async () => {
    let calls = 0;
    const db = {
      connect: async () => {
        calls++;
        throw new Error('database accessed');
      },
      query: async () => {
        calls++;
        throw new Error('database accessed');
      },
    } as never;
    const app = createApp(db, { cookieSecret: 'test-secret', rateLimit: 100 });
    const payload = {
      email: 'minor@example.test',
      password: 'a-unique-password-123',
      displayName: 'Player',
      birthdate: '2015-01-01',
      termsVersion: 'v1',
    };
    const minor = await app.inject({
      method: 'POST',
      url: '/api/signup',
      payload,
    });
    expect(minor.statusCode).toBe(403);
    expect(minor.json()).toEqual({
      code: 'UNDERAGE',
      message: 'You must be 18 or older to create an account.',
    });
    expect(minor.body).not.toContain(payload.birthdate);
    const cookie = minor.headers['set-cookie'];
    expect(cookie).toBeTruthy();
    const blocked = await app.inject({
      method: 'POST',
      url: '/api/signup',
      headers: { cookie },
      payload: { ...payload, birthdate: '1990-01-01' },
    });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json()).toEqual(minor.json());
    expect(calls).toBe(0);
    await app.close();
  });
  it('reports database outage without revealing details', async () => {
    const app = createApp({
      query: async () => {
        throw new Error('secret');
      },
    } as never);
    const response = await app.inject('/readyz');
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain('secret');
    await app.close();
  });
  it('redacts credentials and birthdate from structured logs', () => {
    let output = '';
    const logger = createLogger({
      write(chunk: string) {
        output += chunk;
      },
    });
    logger.info({
      req: {
        method: 'GET',
        url: '/',
        id: 'test',
        headers: { cookie: 'cookie-secret' },
      },
      password: 'password-secret',
      token: 'token-secret',
      birthdate: 'birth-secret',
      dob: 'dob-secret',
    });
    for (const secret of [
      'cookie-secret',
      'password-secret',
      'token-secret',
      'birth-secret',
      'dob-secret',
    ])
      expect(output).not.toContain(secret);
  });
  it('rejects invalid configuration without echoing secrets', () => {
    expect(() => loadConfig({ DATABASE_URL: 'secret-password' })).toThrow(
      'Invalid server environment',
    );
    try {
      loadConfig({ DATABASE_URL: 'secret-password' });
    } catch (error) {
      expect(String(error)).not.toContain('secret-password');
    }
  });
});
