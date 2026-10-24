import { describe, expect, it } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { getClientIp } from '../../src/gateway/clientIp.js';

function request(
  remoteAddress: string,
  forwardedFor?: string,
): IncomingMessage {
  return {
    socket: { remoteAddress },
    headers:
      forwardedFor === undefined ? {} : { 'x-forwarded-for': forwardedFor },
  } as IncomingMessage;
}

describe('WebSocket upgrade client IP', () => {
  it('ignores spoofed forwarded addresses when trustProxy is off', () => {
    expect(getClientIp(request('198.51.100.10', '203.0.113.99'), false)).toBe(
      '198.51.100.10',
    );
  });

  it('separates forwarded clients into distinct IP keys when proxy trust is enabled', () => {
    const first = getClientIp(request('10.0.0.1', '203.0.113.10'), true);
    const second = getClientIp(request('10.0.0.1', '203.0.113.11'), true);

    expect(first).toBe('203.0.113.10');
    expect(second).toBe('203.0.113.11');
    expect(first).not.toBe(second);
  });

  it('uses the rightmost forwarded address with one trusted hop', () => {
    expect(
      getClientIp(request('10.0.0.1', '198.51.100.20, 203.0.113.20'), 1),
    ).toBe('203.0.113.20');
  });

  it('walks two trusted hops when configured for two', () => {
    expect(
      getClientIp(request('10.0.0.1', '198.51.100.20, 203.0.113.20'), 2),
    ).toBe('198.51.100.20');
  });

  it('falls back to the socket address for malformed or missing headers', () => {
    expect(getClientIp(request('10.0.0.1', 'not-an-ip'), true)).toBe(
      '10.0.0.1',
    );
    expect(getClientIp(request('10.0.0.1'), true)).toBe('10.0.0.1');
  });
});
