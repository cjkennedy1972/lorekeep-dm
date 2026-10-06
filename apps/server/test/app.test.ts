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
