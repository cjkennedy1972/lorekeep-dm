import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { installGateway } from '../../src/gateway/ws.js';
import { allowInputGate } from '../support/allowInputGate.js';

const host = 'api.example.test';

async function postTicket(origin: string | undefined) {
  const db = {
    connect: async () => undefined,
    query: async () => ({ rows: [], rowCount: 0 }),
  };
  const app = createApp(db as never, {
    inputGate: allowInputGate,
    rooms: { get: async () => undefined } as never,
    isOperator: async () => false,
  });
  installGateway(app, db as never, { get: async () => undefined } as never);
  const res = await app.inject({
    method: 'POST',
    url: '/api/ws-ticket',
    headers: { host, ...(origin ? { origin } : {}) },
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

  it('rejects a scheme-mismatched same-host origin on an HTTP request', async () => {
    delete process.env.WS_ALLOWED_ORIGINS;
    expect(await postTicket(`https://${host}`)).toBe(403);
  });

  it('accepts a same-scheme same-host origin', async () => {
    delete process.env.WS_ALLOWED_ORIGINS;
    expect(await postTicket(`http://${host}`)).toBe(401);
  });

  it('rejects a missing origin', async () => {
    delete process.env.WS_ALLOWED_ORIGINS;
    expect(await postTicket(undefined)).toBe(403);
  });

  it('rejects a foreign origin', async () => {
    delete process.env.WS_ALLOWED_ORIGINS;
    expect(await postTicket('http://evil.example.test')).toBe(403);
  });

  it('accepts an exact WS_ALLOWED_ORIGINS full origin from another host', async () => {
    process.env.WS_ALLOWED_ORIGINS = 'https://web.example.test';
    expect(await postTicket('https://web.example.test')).toBe(401);
  });

  it('keeps the scheme+host check for same-host origins with WS_ALLOWED_ORIGINS set', async () => {
    process.env.WS_ALLOWED_ORIGINS = 'https://web.example.test';
    expect(await postTicket(`https://${host}`)).toBe(403);
    expect(await postTicket(`http://${host}`)).toBe(401);
  });

  it('does not match a WS_ALLOWED_ORIGINS entry with a trailing slash', async () => {
    process.env.WS_ALLOWED_ORIGINS = 'https://web.example.test';
    expect(await postTicket('https://web.example.test/')).toBe(403);
  });
});
