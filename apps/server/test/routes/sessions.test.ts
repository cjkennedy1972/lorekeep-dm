import { allowInputGate } from '../support/allowInputGate.js';
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createApp, scrubUrl } from '../../src/app.js';
import {
  hashInvite,
  newInviteCode,
  plausibleCode,
} from '../../src/rooms/invites.js';
import { hashToken } from '../../src/accounts/signup.js';
import {
  LateJoinLimitedError,
  LateJoinUnavailableError,
} from '../../src/room/Room.js';
import { createLateJoinRateLimiter } from '../../src/routes/sessions.js';

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
  it('returns the neutral invite-unavailable response when a table ends during a late-join request', async () => {
    const code = newInviteCode();
    const db = {
      connect: async () => undefined,
      query: async (sql: string) => {
        if (sql.includes('UPDATE auth_sessions s SET last_active_at'))
          return {
            rows: [{ account_id: 'account', token_hash: hashToken(token) }],
            rowCount: 1,
          };
        if (sql.includes('s.invite_hash=$1'))
          return {
            rows: [
              {
                id: 'session',
                name: 'Room',
                owner: 'host',
                status: 'active',
                host_tier_cap: null,
              },
            ],
            rowCount: 1,
          };
        if (sql.includes('SELECT display_name, mature_opt_out'))
          return {
            rows: [{ display_name: 'Player', mature_opt_out: false }],
            rowCount: 1,
          };
        return { rows: [], rowCount: 0 };
      },
    };
    const a = createApp(db as never, {
      inputGate: allowInputGate,
      rooms: {
        get: async () => ({
          requestLateJoin: async () => {
            throw new LateJoinUnavailableError();
          },
        }),
      } as never,
    });
    try {
      const response = await a.inject({
        method: 'POST',
        url: `/api/invites/${code}/late-join`,
        headers: cookie,
        payload: {
          characterId: randomUUID(),
          expectedRevision: 1,
          actionId: randomUUID(),
        },
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({
        code: 'INVITE_INVALID',
        message: 'This invite link is no longer valid.',
      });
    } finally {
      await a.close();
    }
  });

  it('maps an ended late-join table to the same neutral invalid-invite response on /api/join', async () => {
    const code = newInviteCode();
    const db = {
      connect: async () => undefined,
      query: async (sql: string) => {
        if (sql.includes('UPDATE auth_sessions s SET last_active_at'))
          return {
            rows: [{ account_id: 'account', token_hash: hashToken(token) }],
            rowCount: 1,
          };
        if (sql.includes('s.invite_hash=$1'))
          return {
            rows: [
              {
                id: 'session',
                name: 'Room',
                owner: 'host',
                status: 'active',
                host_tier_cap: null,
              },
            ],
            rowCount: 1,
          };
        if (sql.includes('SELECT display_name, mature_opt_out'))
          return {
            rows: [{ display_name: 'Player', mature_opt_out: false }],
            rowCount: 1,
          };
        return { rows: [], rowCount: 0 };
      },
    };
    const a = createApp(db as never, {
      inputGate: allowInputGate,
      rooms: {
        get: async () => ({
          state: { seats: [], gameState: {} },
          requestLateJoin: async () => {
            throw new LateJoinUnavailableError();
          },
        }),
      } as never,
    });
    try {
      const response = await a.inject({
        method: 'POST',
        url: `/api/join/${code}`,
        headers: cookie,
        payload: {
          characterId: randomUUID(),
          expectedRevision: 1,
          actionId: randomUUID(),
        },
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({
        code: 'INVITE_INVALID',
        message: 'This invite link is no longer valid.',
      });
    } finally {
      await a.close();
    }
  });

  it('enforces the late-join account burst of 3 then one request every 2 minutes', () => {
    const limit = createLateJoinRateLimiter();
    const attempt = (now: number) =>
      limit('account', 'ip', `invite-${now}`, now);
    expect(attempt(0)).toBeUndefined();
    expect(attempt(1)).toBeUndefined();
    expect(attempt(2)).toBeUndefined();
    expect(attempt(3)).toBe(120);
    expect(attempt(120_002)).toBeUndefined();
    expect(attempt(120_003)).toBe(120);
    expect(attempt(240_002)).toBeUndefined();
  });

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

  it('enforces late-join account, IP, invite, and pending-request limits over HTTP', async () => {
    const codes = new Map<string, { id: string; owner: string }>();
    const accounts = new Map<string, string>();
    const tokens = Array.from({ length: 12 }, (_, index) =>
      String.fromCharCode(97 + index).repeat(43),
    );
    tokens.forEach((value, index) =>
      accounts.set(hashToken(value), `account-${index}`),
    );
    const db = {
      connect: async () => undefined,
      query: async (sql: string, values: unknown[] = []) => {
        if (sql.includes('UPDATE auth_sessions s SET last_active_at')) {
          const tokenHash = String(values[0]);
          return {
            rows: accounts.has(tokenHash)
              ? [{ account_id: accounts.get(tokenHash), token_hash: tokenHash }]
              : [],
            rowCount: accounts.has(tokenHash) ? 1 : 0,
          };
        }
        if (sql.includes('s.invite_hash=$1')) {
          const room = codes.get(String(values[0]));
          return {
            rows: room
              ? [
                  {
                    id: room.id,
                    name: 'Room',
                    owner: room.owner,
                    status: 'active',
                    host_tier_cap: null,
                  },
                ]
              : [],
            rowCount: room ? 1 : 0,
          };
        }
        if (sql.includes('SELECT content_tier, moderation_verified'))
          return {
            rows: [
              {
                content_tier: 'standard',
                moderation_verified: true,
                host_tier_cap: null,
                endpoint_allows_mature: false,
              },
            ],
            rowCount: 1,
          };
        if (sql.includes('SELECT content_tier, host_tier_cap'))
          return {
            rows: [{ content_tier: 'standard', host_tier_cap: null }],
            rowCount: 1,
          };
        if (sql.includes('SELECT display_name, mature_opt_out'))
          return {
            rows: [{ display_name: 'Player', mature_opt_out: false }],
            rowCount: 1,
          };
        if (sql.includes('SELECT content_lines, content_veils'))
          return {
            rows: [{ content_lines: [], content_veils: [] }],
            rowCount: 1,
          };
        return { rows: [], rowCount: 0 };
      },
    };
    const addCode = () => {
      const code = newInviteCode();
      codes.set(hashInvite(code), { id: randomUUID(), owner: 'host' });
      return code;
    };
    const a = createApp(db as never, {
      inputGate: allowInputGate,
      rooms: {
        get: async () => ({ requestLateJoin: async () => randomUUID() }),
      } as never,
    });
    const hit = (
      server: ReturnType<typeof createApp>,
      tokenValue: string,
      code: string,
    ) =>
      server.inject({
        method: 'POST',
        url: `/api/invites/${code}/late-join`,
        headers: { cookie: `sid=${tokenValue}` },
        payload: {
          characterId: randomUUID(),
          expectedRevision: 1,
          actionId: randomUUID(),
        },
      });
    try {
      const accountCode = [addCode(), addCode(), addCode(), addCode()];
      for (const code of accountCode.slice(0, 3))
        expect((await hit(a, tokens[0]!, code)).statusCode).toBe(202);
      expect((await hit(a, tokens[0]!, accountCode[3]!)).statusCode).toBe(429);
    } finally {
      await a.close();
    }

    const ipCodes = Array.from({ length: 11 }, addCode);
    const ipApp = createApp(db as never, {
      inputGate: allowInputGate,
      rooms: {
        get: async () => ({ requestLateJoin: async () => randomUUID() }),
      } as never,
    });
    try {
      for (let index = 0; index < 10; index++)
        expect(
          (await hit(ipApp, tokens[index]!, ipCodes[index]!)).statusCode,
        ).toBe(202);
      expect((await hit(ipApp, tokens[10]!, ipCodes[10]!)).statusCode).toBe(
        429,
      );
    } finally {
      await ipApp.close();
    }

    const inviteCode = addCode();
    const inviteApp = createApp(db as never, {
      inputGate: allowInputGate,
      rooms: {
        get: async () => ({ requestLateJoin: async () => randomUUID() }),
      } as never,
    });
    try {
      for (let index = 0; index < 5; index++)
        expect(
          (
            await inviteApp.inject({
              method: 'POST',
              url: `/api/invites/${inviteCode}/late-join`,
              headers: { cookie: `sid=${tokens[index + 1]}` },
              payload: {
                characterId: randomUUID(),
                expectedRevision: 1,
                actionId: randomUUID(),
              },
            })
          ).statusCode,
        ).toBe(202);
      const limited = await inviteApp.inject({
        method: 'POST',
        url: `/api/invites/${inviteCode}/late-join`,
        headers: { cookie: `sid=${tokens[6]}` },
        payload: {
          characterId: randomUUID(),
          expectedRevision: 1,
          actionId: randomUUID(),
        },
      });
      expect(limited.statusCode).toBe(429);
    } finally {
      await inviteApp.close();
    }

    let pendingCount = 0;
    const pendingApp = createApp(db as never, {
      inputGate: allowInputGate,
      rooms: {
        get: async () => ({
          requestLateJoin: async () => {
            if (pendingCount >= 3) throw new LateJoinLimitedError();
            pendingCount++;
            return randomUUID();
          },
        }),
      } as never,
    });
    const pendingCode = addCode();
    try {
      for (let index = 0; index < 3; index++)
        expect(
          (await hit(pendingApp, tokens[index]!, pendingCode)).statusCode,
        ).toBe(202);
      expect((await hit(pendingApp, tokens[3]!, pendingCode)).statusCode).toBe(
        429,
      );
    } finally {
      await pendingApp.close();
    }
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
        if (/FROM sessions s[\s\S]*invite_hash/.test(sql))
          return {
            rows: [
              {
                id: 'room',
                name: 'Room',
                owner: 'acc',
                status: 'active',
                host_tier_cap: null,
                is_member: false,
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

describe('leave table', () => {
  const roomId = '11111111-1111-4111-8111-111111111111';
  function leaveApp(opts: { owner: string; member: boolean }) {
    const left: string[] = [];
    const db = {
      connect: async () => undefined,
      query: async (sql: string) => {
        if (/UPDATE auth_sessions/.test(sql))
          return {
            rows: [{ account_id: 'acc', token_hash: 'h' }],
            rowCount: 1,
          };
        if (/AND s\.id=\$2/.test(sql))
          return { rows: [], rowCount: opts.member ? 1 : 0 };
        if (/SELECT owner_account_id AS owner FROM sessions/.test(sql))
          return { rows: [{ owner: opts.owner }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      },
    };
    const app = createApp(db as never, {
      inputGate: allowInputGate,
      rooms: {
        get: async () => ({ leave: async (id: string) => void left.push(id) }),
      } as never,
    });
    return { app, left };
  }

  it('non-member gets 404 and the room is not touched', async () => {
    const { app, left } = leaveApp({ owner: 'host', member: false });
    const res = await app.inject({
      method: 'POST',
      url: `/api/rooms/${roomId}/leave`,
      headers: cookie,
    });
    expect(res.statusCode).toBe(404);
    expect(left).toEqual([]);
    await app.close();
  });

  it('host cannot leave their own table', async () => {
    const { app, left } = leaveApp({ owner: 'acc', member: true });
    const res = await app.inject({
      method: 'POST',
      url: `/api/rooms/${roomId}/leave`,
      headers: cookie,
    });
    expect(res.statusCode).toBe(403);
    expect(left).toEqual([]);
    await app.close();
  });

  it('seated player leaves and the seat is revoked', async () => {
    const { app, left } = leaveApp({ owner: 'host', member: true });
    const res = await app.inject({
      method: 'POST',
      url: `/api/rooms/${roomId}/leave`,
      headers: cookie,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(left).toEqual(['acc']);
    await app.close();
  });
});
