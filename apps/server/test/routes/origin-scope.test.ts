import { allowInputGate } from '../support/allowInputGate.js';
import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { createApp, createLogger } from '../../src/app.js';
import { originScope } from '../../src/middleware/origin.js';

const foreign = { origin: 'https://evil.example', host: 'game.example.test' };

describe('origin protection is scoped to route groups', () => {
  it('guards routes registered in a scope and not routes outside it', async () => {
    const app = Fastify({ loggerInstance: createLogger() });
    originScope(app, (scope) => {
      scope.post('/scoped', async () => ({ ok: true }));
    });
    app.post('/outside', async () => ({ ok: true }));
    const scoped = await app.inject({
      method: 'POST',
      url: '/scoped',
      headers: foreign,
      payload: {},
    });
    const outside = await app.inject({
      method: 'POST',
      url: '/outside',
      headers: foreign,
      payload: {},
    });
    await app.close();
    expect(scoped.statusCode).toBe(403);
    expect(outside.statusCode).toBe(200);
  });

  it('keeps root telemetry hooks running for origin-rejected scoped requests', async () => {
    const seen: string[] = [];
    const app = Fastify({ loggerInstance: createLogger() });
    app.addHook('onRequest', async (request) => {
      seen.push(request.url);
    });
    originScope(app, (scope) => {
      scope.post('/scoped', async () => ({ ok: true }));
    });
    const res = await app.inject({
      method: 'POST',
      url: '/scoped',
      headers: foreign,
      payload: {},
    });
    await app.close();
    expect(res.statusCode).toBe(403);
    expect(seen).toEqual(['/scoped']);
  });

  it.each([
    ['POST', '/api/tables'],
    ['POST', '/api/login'],
    ['POST', '/api/signup'],
    ['POST', '/api/me/password'],
    ['POST', '/api/operator/endpoints/chat/test'],
  ])(
    '%s %s through createApp rejects a foreign Origin',
    async (method, url) => {
      const app = createApp(
        {
          connect: async () => undefined,
          query: async () => ({ rows: [], rowCount: 0 }),
        } as never,
        {
          inputGate: allowInputGate,
          rooms: { get: async () => undefined } as never,
          isOperator: async () => false,
        },
      );
      const res = await app.inject({
        method: method as 'POST',
        url,
        headers: foreign,
        payload: {},
      });
      await app.close();
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('BAD_ORIGIN');
    },
  );
});
