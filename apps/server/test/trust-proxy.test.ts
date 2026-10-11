import { allowInputGate } from './support/allowInputGate.js';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { parseTrustProxy } from '../src/config.js';

const noDb = { query: async () => ({ rows: [] }) } as never;
const clientIp = async (
  trustProxy: boolean | number | string[],
  remoteAddress: string,
  forwardedFor: string,
) => {
  const app = createApp(
    noDb,
    { inputGate: allowInputGate, trustProxy },
    { inputGate: allowInputGate },
  );
  app.get('/whoami', (request) => ({ ip: request.ip }));
  const response = await app.inject({
    method: 'GET',
    url: '/whoami',
    remoteAddress,
    headers: { 'x-forwarded-for': forwardedFor },
  });
  await app.close();
  return response.json<{ ip: string }>().ip;
};

describe('forwarded client address', () => {
  it('with one hop, does not trust a client-supplied leftmost entry', async () => {
    expect(await clientIp(1, '10.0.0.1', '6.6.6.6, 203.0.113.9')).toBe(
      '203.0.113.9',
    );
  });
  it('trusts forwarded entries only from listed proxies', async () => {
    expect(
      await clientIp(['10.0.0.0/8'], '10.1.2.3', '6.6.6.6, 203.0.113.9'),
    ).toBe('203.0.113.9');
    expect(await clientIp(['10.0.0.0/8'], '198.51.100.4', '6.6.6.6')).toBe(
      '198.51.100.4',
    );
  });
});

describe('TRUST_PROXY parsing', () => {
  it('keeps true and false as booleans', () => {
    expect(parseTrustProxy('true')).toBe(true);
    expect(parseTrustProxy('false')).toBe(false);
  });
  it('reads digits as a hop count, where 0 trusts nothing', () => {
    expect(parseTrustProxy('1')).toBe(1);
    expect(parseTrustProxy('2')).toBe(2);
    expect(parseTrustProxy('0')).toBe(false);
  });
  it('reads a comma-separated list as trusted proxy addresses or CIDRs', () => {
    expect(parseTrustProxy('10.0.0.0/8, 127.0.0.1')).toEqual([
      '10.0.0.0/8',
      '127.0.0.1',
    ]);
    expect(parseTrustProxy('fd00::/8')).toEqual(['fd00::/8']);
  });
  it('rejects values that are none of the above', () => {
    expect(() => parseTrustProxy('yes please')).toThrow(/TRUST_PROXY/);
    expect(() => parseTrustProxy('10.0.0.0/99')).toThrow(/TRUST_PROXY/);
    expect(() => parseTrustProxy('')).toThrow(/TRUST_PROXY/);
  });
});
