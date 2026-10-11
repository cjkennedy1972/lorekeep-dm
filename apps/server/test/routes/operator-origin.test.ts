import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { createApp, createLogger } from '../../src/app.js';
import { registerOperatorRoutes } from '../../src/routes/operator.js';

const operatorRoutes = [
  ['PUT', '/api/operator/endpoints/chat'],
  ['POST', '/api/operator/endpoints/chat/test'],
  ['DELETE', '/api/operator/endpoints/chat'],
] as const;

const noop = {} as never;

function bareOperatorApp() {
  const app = Fastify({ loggerInstance: createLogger() });
  registerOperatorRoutes(app, noop, async () => false, {
    egress: noop,
  });
  return app;
}

const appDb = {
  connect: async () => undefined,
  query: async () => ({ rows: [], rowCount: 0 }),
};

describe('operator non-GET routes reject foreign Origin', () => {
  it.each(operatorRoutes)(
    '%s %s rejects a foreign Origin',
    async (method, url) => {
      const app = bareOperatorApp();
      const res = await app.inject({
        method,
        url,
        headers: { origin: 'https://evil.example', host: 'game.example.test' },
        payload: {},
      });
      await app.close();
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({
        code: 'BAD_ORIGIN',
        message: 'Origin not allowed.',
      });
    },
  );

  it.each(operatorRoutes)(
    '%s %s through createApp rejects a foreign Origin',
    async (method, url) => {
      const app = createApp(appDb as never, {
        rooms: { get: async () => undefined } as never,
        isOperator: async () => false,
      });
      const res = await app.inject({
        method,
        url,
        headers: { origin: 'https://evil.example', host: 'game.example.test' },
        payload: {},
      });
      await app.close();
      expect(res.json().code).toBe('BAD_ORIGIN');
    },
  );
});

describe('operator non-GET routes keep same-origin and no-Origin behavior', () => {
  it.each(operatorRoutes)(
    '%s %s with same-origin reaches authorization',
    async (method, url) => {
      const app = bareOperatorApp();
      const res = await app.inject({
        method,
        url,
        headers: {
          origin: 'http://game.example.test',
          host: 'game.example.test',
        },
        payload: {},
      });
      await app.close();
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('NOT_FOUND');
    },
  );

  it('a non-browser request with no Origin reaches authorization', async () => {
    const app = bareOperatorApp();
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/operator/endpoints/chat',
      headers: { host: 'game.example.test' },
    });
    await app.close();
    expect(res.json().code).toBe('NOT_FOUND');
  });

  it('GET is not origin-checked', async () => {
    const app = bareOperatorApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/operator/endpoints',
      headers: { origin: 'https://evil.example', host: 'game.example.test' },
    });
    await app.close();
    expect(res.json().code).toBe('NOT_FOUND');
  });
});

describe('operator Origin check behind a TLS proxy', () => {
  const headers = {
    origin: 'https://game.example.test',
    host: 'game.example.test',
    'x-forwarded-proto': 'https',
  };

  it('accepts the https same-origin request when TRUST_PROXY is set', async () => {
    const app = createApp(appDb as never, {
      rooms: { get: async () => undefined } as never,
      isOperator: async () => false,
      trustProxy: true,
    });
    const res = await app.inject({
      method: 'PUT',
      url: '/api/operator/endpoints/chat',
      headers,
      payload: {},
    });
    await app.close();
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('NOT_FOUND');
  });

  it('rejects the same request when TRUST_PROXY is not set', async () => {
    const app = createApp(appDb as never, {
      rooms: { get: async () => undefined } as never,
      isOperator: async () => false,
    });
    const res = await app.inject({
      method: 'PUT',
      url: '/api/operator/endpoints/chat',
      headers,
      payload: {},
    });
    await app.close();
    expect(res.json().code).toBe('BAD_ORIGIN');
  });
});
