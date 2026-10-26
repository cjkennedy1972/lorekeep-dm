import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { installGateway } from '../../src/gateway/ws.js';
import { allowInputGate } from '../support/allowInputGate.js';

const host = 'api.example.test';

async function postTicket(
  origin: string | undefined,
  requestScheme = 'http',
  allowConfiguredOriginForTicket = false,
) {
  const db = {
    connect: async () => undefined,
    query: async () => ({ rows: [], rowCount: 0 }),
  };
  const app = createApp(db as never, {
    inputGate: allowInputGate,
    rooms: { get: async () => undefined } as never,
    isOperator: async () => false,
    trustProxy: true,
  });
  installGateway(
    app,
    db as never,
    { get: async () => undefined } as never,
    undefined,
    undefined,
    undefined,
    allowConfiguredOriginForTicket,
  );
  const res = await app.inject({
    method: 'POST',
    url: '/api/ws-ticket',
    headers: {
      host,
      'x-forwarded-proto': requestScheme,
      ...(origin ? { origin } : {}),
    },
    payload: {},
  });
  await app.close();
  return res.statusCode;
}

describe('POST /api/ws-ticket origin check', () => {
  const saved = process.env.WS_ALLOWED_ORIGINS;
  afterEach(() => {
    if (saved === undefined) delete process.env.WS_ALLOWED_ORIGINS;
    else process.env.WS_ALLOWED_ORIGINS = saved;
  });

  it('normalizes a same-host origin before matching it', async () => {
    delete process.env.WS_ALLOWED_ORIGINS;
    expect(await postTicket(`https://${host}`, 'https')).toBe(401);
  });

  it('accepts a same-scheme same-host origin', async () => {
    delete process.env.WS_ALLOWED_ORIGINS;
    expect(await postTicket(`http://${host}`, 'http')).toBe(401);
  });

  it('rejects a missing origin', async () => {
    delete process.env.WS_ALLOWED_ORIGINS;
    expect(await postTicket(undefined)).toBe(403);
  });

  it('rejects a foreign origin', async () => {
    delete process.env.WS_ALLOWED_ORIGINS;
    expect(await postTicket('http://evil.example.test')).toBe(403);
  });

  it('does not allow WS_ALLOWED_ORIGINS to bypass the ticket origin check by default', async () => {
    process.env.WS_ALLOWED_ORIGINS = 'https://web.example.test';
    expect(await postTicket('https://web.example.test', 'https')).toBe(403);
  });

  it('allows an exact configured origin for ticket requests when explicitly enabled', async () => {
    process.env.WS_ALLOWED_ORIGINS = 'https://web.example.test';
    expect(await postTicket('https://web.example.test', 'https', true)).toBe(
      401,
    );
  });

  it('keeps the scheme+host check for same-host origins with WS_ALLOWED_ORIGINS set', async () => {
    process.env.WS_ALLOWED_ORIGINS = 'https://web.example.test';
    expect(await postTicket(`https://${host}`, 'https')).toBe(401);
    expect(await postTicket(`http://${host}`, 'https')).toBe(403);
    expect(await postTicket('https://web.example.test', 'https')).toBe(403);
  });

  it('normalizes a trailing slash in WS_ALLOWED_ORIGINS matching', async () => {
    process.env.WS_ALLOWED_ORIGINS = 'https://web.example.test';
    expect(await postTicket('https://web.example.test/', 'https', true)).toBe(
      401,
    );
    process.env.WS_ALLOWED_ORIGINS = 'https://web.example.test/';
    expect(await postTicket('https://web.example.test', 'https')).toBe(403);
  });
});
