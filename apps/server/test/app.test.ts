import { allowInputGate } from './support/allowInputGate.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, createLogger } from '../src/app.js';
import { loadConfig } from '../src/config.js';

describe('server app', () => {
  it('answers liveness and readiness', async () => {
    const app = createApp({ query: async () => ({ rows: [] }) } as never, {
      inputGate: allowInputGate,
    });
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
    const app = createApp(
      db,
      {
        inputGate: allowInputGate,
        cookieSecret: 'test-secret',
        rateLimit: 100,
      },
      { inputGate: allowInputGate },
    );
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
    const app = createApp(
      {
        query: async () => {
          throw new Error('secret');
        },
      } as never,
      { inputGate: allowInputGate },
    );
    const response = await app.inject('/readyz');
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain('secret');
    await app.close();
  });
  it('reports the sweep as stale when its health read fails, without leaking details', async () => {
    const app = createApp(
      {
        query: async (sql: string) => {
          if (sql.startsWith('SELECT 1')) return { rows: [] };
          throw new Error('secret');
        },
      } as never,
      { inputGate: allowInputGate },
    );
    const response = await app.inject('/readyz');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: 'ready',
      retention: { lastCompletedAt: null, stale: true },
    });
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

describe('reverse proxy trust', () => {
  const noDb = {
    connect: async () => {
      throw new Error('database accessed');
    },
    query: async () => {
      throw new Error('database accessed');
    },
  } as never;
  const underage = {
    email: 'minor@example.test',
    password: 'a-unique-password-123',
    displayName: 'Player',
    birthdate: '2015-01-01',
    termsVersion: 'v1',
  };
  const build = (trustProxy: boolean) =>
    createApp(
      noDb,
      {
        inputGate: allowInputGate,
        cookieSecret: 'test-secret',
        rateLimit: 1,
        trustProxy,
      },
      { inputGate: allowInputGate },
    );
  const signupFrom = (
    app: ReturnType<typeof build>,
    client: string,
    headers: Record<string, string> = {},
  ) =>
    app.inject({
      method: 'POST',
      url: '/api/signup',
      remoteAddress: '10.0.0.1',
      headers: { 'x-forwarded-for': client, ...headers },
      payload: { ...underage, email: `${client}@example.test` },
    });

  it('keys rate limits on the forwarded client when trusted', async () => {
    const app = build(true);
    expect((await signupFrom(app, '203.0.113.1')).statusCode).toBe(403);
    expect((await signupFrom(app, '203.0.113.1')).statusCode).toBe(429);
    const other = await signupFrom(app, '203.0.113.2');
    expect(other.statusCode).toBe(403);
    expect(other.json().code).toBe('UNDERAGE');
    await app.close();
  });

  it('ignores forwarded client addresses when not trusted', async () => {
    const app = build(false);
    expect((await signupFrom(app, '203.0.113.1')).statusCode).toBe(403);
    expect((await signupFrom(app, '203.0.113.2')).statusCode).toBe(429);
    await app.close();
  });

  it('accepts an https Origin behind a TLS-terminating proxy only when trusted', async () => {
    const headers = {
      origin: 'https://game.example.test',
      host: 'game.example.test',
      'x-forwarded-proto': 'https',
    };
    const trusted = build(true);
    expect(
      (await signupFrom(trusted, '203.0.113.9', headers)).json().code,
    ).toBe('UNDERAGE');
    await trusted.close();
    const untrusted = build(false);
    expect(
      (await signupFrom(untrusted, '203.0.113.9', headers)).json().code,
    ).toBe('BAD_ORIGIN');
    await untrusted.close();
  });
});

describe('cookie secret and secure defaults', () => {
  const db = {
    connect: async () => {},
    query: async () => ({ rows: [] }),
  } as never;
  const saved = {
    env: process.env.NODE_ENV,
    secret: process.env.AGE_RETRY_SECRET,
  };
  afterEach(() => {
    if (saved.env === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = saved.env;
    if (saved.secret === undefined) delete process.env.AGE_RETRY_SECRET;
    else process.env.AGE_RETRY_SECRET = saved.secret;
  });
  it('refuses to boot without AGE_RETRY_SECRET unless NODE_ENV is development or test', () => {
    delete process.env.AGE_RETRY_SECRET;
    for (const env of [undefined, 'production', 'prodution', '']) {
      if (env === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = env;
      expect(() => createApp(db, { inputGate: allowInputGate })).toThrow(
        'AGE_RETRY_SECRET is required',
      );
    }
  });
  it('boots with the development fallback only when NODE_ENV is development or test', async () => {
    delete process.env.AGE_RETRY_SECRET;
    for (const env of ['development', 'test']) {
      process.env.NODE_ENV = env;
      const app = createApp(db, { inputGate: allowInputGate });
      await app.close();
    }
  });
  it('marks the age-gate retry cookie Secure in production behind a trusted proxy', async () => {
    process.env.NODE_ENV = 'production';
    const app = createApp(
      db,
      {
        inputGate: allowInputGate,
        cookieSecret: 'test-secret',
        trustProxy: true,
      },
      { inputGate: allowInputGate },
    );
    const minor = await app.inject({
      method: 'POST',
      url: '/api/signup',
      headers: { 'x-forwarded-proto': 'https' },
      payload: {
        email: 'minor@example.test',
        password: 'a-unique-password-123',
        displayName: 'Player',
        birthdate: '2015-01-01',
        termsVersion: 'v1',
      },
    });
    expect(minor.statusCode).toBe(403);
    expect(String(minor.headers['set-cookie'])).toContain('; Secure');
    await app.close();
  });
});
