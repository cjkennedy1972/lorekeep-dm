import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { validOrigin } from '../../src/middleware/origin.js';

function app() {
  const server = Fastify();
  server.post('/', async (request) => ({ ok: validOrigin(request) }));
  return server;
}

async function check(origin: string, host: string) {
  const server = app();
  const res = await server.inject({
    method: 'POST',
    url: '/',
    headers: { origin, host },
  });
  await server.close();
  return res.json().ok as boolean;
}

describe('HTTP origin policy requires scheme and host to match', () => {
  it('accepts same-scheme same-host origins', async () => {
    expect(await check('http://game.example', 'game.example')).toBe(true);
  });

  it('rejects an https origin when the request is http', async () => {
    expect(await check('https://game.example', 'game.example')).toBe(false);
  });

  it('rejects a different host even with the same scheme', async () => {
    expect(await check('http://evil.example', 'game.example')).toBe(false);
  });
});
