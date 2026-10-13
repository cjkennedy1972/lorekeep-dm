import { allowInputGate } from '../support/allowInputGate.js';
import { describe, expect, it } from 'vitest';
import { createApp, scrubUrl } from '../../src/app.js';
import {
  hashInvite,
  newInviteCode,
  plausibleCode,
} from '../../src/rooms/invites.js';

const token = 'a'.repeat(43);
function fakeDb(account: 'none' | 'active' | 'pending') {
  return {
    connect: async () => undefined,
    query: async (sql: string) => {
      if (/UPDATE auth_sessions/.test(sql))
        return {
          rows:
            account === 'active'
              ? [{ account_id: 'acc', token_hash: 'h' }]
              : [],
          rowCount: account === 'active' ? 1 : 0,
        };
      if (/a\.status='pending_email'/.test(sql))
        return { rows: [], rowCount: account === 'pending' ? 1 : 0 };
      return { rows: [], rowCount: 0 };
    },
  };
}
const rooms = {
  get: async () => {
    throw new Error('not reached');
  },
};
const app = (account: 'none' | 'active' | 'pending') =>
  createApp(fakeDb(account) as never, {
    inputGate: allowInputGate,
    rooms: rooms as never,
  });
const cookie = { cookie: `sid=${token}` };

describe('invite codes', () => {
  it('are >=128-bit, unique, and hashed with sha256', () => {
    const code = newInviteCode();
    expect(Buffer.from(code, 'base64url')).toHaveLength(16);
    expect(plausibleCode(code)).toBe(true);
    expect(newInviteCode()).not.toBe(code);
    expect(hashInvite(code)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashInvite(code)).not.toContain(code);
  });
  it('scrubUrl hides the code in both join paths', () => {
    expect(scrubUrl('/api/invites/SECRET123/join?x=1')).toBe(
      '/api/invites/[REDACTED]/join',
    );
    expect(scrubUrl('/api/join/SECRET123')).toBe('/api/join/[REDACTED]');
  });
});

describe('room routes', () => {
  it('unauthenticated join -> 401 with login + returnTo hint', async () => {
    const res = await app('none').inject({
      method: 'POST',
      url: '/api/invites/abc/join',
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({
      code: 'UNAUTHENTICATED',
      loginRequired: true,
      returnTo: '/join/abc',
    });
  });
  it('unverified account -> 403 on create and join', async () => {
    const a = app('pending');
    for (const url of ['/api/rooms', '/api/sessions', '/api/join/abc']) {
      const res = await a.inject({
        method: 'POST',
        url,
        headers: cookie,
        payload: { name: 'x' },
      });
      expect(res.statusCode, url).toBe(403);
      expect(res.json().code).toBe('EMAIL_UNVERIFIED');
    }
  });
  it('rejects cross-origin mutations', async () => {
    const res = await app('active').inject({
      method: 'POST',
      url: '/api/rooms',
      headers: { ...cookie, origin: 'https://evil.example' },
      payload: { name: 'x' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('BAD_ORIGIN');
  });
  it('validates the room name', async () => {
    const res = await app('active').inject({
      method: 'POST',
      url: '/api/rooms',
      headers: cookie,
      payload: { name: '   ' },
    });
    expect(res.statusCode).toBe(400);
  });
  it('unknown code -> 404 INVITE_INVALID; rate limited per ip+code', async () => {
    const a = createApp(fakeDb('active') as never, {
      inputGate: allowInputGate,
      rooms: rooms as never,
      joinRateLimit: 2,
    });
    const hit = () =>
      a.inject({ method: 'POST', url: '/api/join/nope', headers: cookie });
    expect((await hit()).statusCode).toBe(404);
    expect((await hit()).statusCode).toBe(404);
    expect((await hit()).statusCode).toBe(429);
  });

  it('does not persist a changed opt-out when invite seating fails', async () => {
    const code = newInviteCode();
    const updates: unknown[][] = [];
    const db = {
      connect: async () => undefined,
      query: async (sql: string, values: unknown[] = []) => {
        if (/UPDATE auth_sessions/.test(sql))
          return {
            rows: [{ account_id: 'acc', token_hash: 'h' }],
            rowCount: 1,
          };
        if (/FROM sessions WHERE invite_hash/.test(sql))
          return {
            rows: [
              {
                id: 'room',
                name: 'Room',
                owner: 'host',
                status: 'active',
                host_tier_cap: null,
              },
            ],
            rowCount: 1,
          };
        if (/SELECT display_name, mature_opt_out FROM accounts/.test(sql))
          return {
            rows: [{ display_name: 'Player', mature_opt_out: false }],
            rowCount: 1,
          };
        if (/UPDATE accounts SET mature_opt_out/.test(sql)) {
          updates.push(values);
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
    };
    let attemptedOptOut: boolean | undefined;
    const app = createApp(db as never, {
      inputGate: allowInputGate,
      rooms: {
        get: async () => ({
          seat: async (_id: string, _name: string, matureOptOut: boolean) => {
            attemptedOptOut = matureOptOut;
            throw new Error('Room is full');
          },
        }),
      } as never,
    });

    const response = await app.inject({
      method: 'POST',
      url: `/api/invites/${code}/join`,
      headers: cookie,
      payload: { matureOptOut: true },
    });
    expect(response.statusCode).toBe(409);
    expect(attemptedOptOut).toBe(true);
    expect(updates).toHaveLength(0);
    await app.close();
  });
});
