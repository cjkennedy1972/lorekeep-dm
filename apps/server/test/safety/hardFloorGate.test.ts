import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import type {
  InputCheck,
  InputDecision,
  InputGate,
} from '../../src/safety/inputGate.js';

const token = 'a'.repeat(43);
const fakeDb = (queries: string[], rowCount = 0) =>
  ({
    connect: async () => undefined,
    query: async (sql: string) => {
      queries.push(sql);
      if (/UPDATE auth_sessions/.test(sql))
        return { rows: [{ account_id: 'acc', token_hash: 'h' }], rowCount: 1 };
      return { rows: [], rowCount };
    },
  }) as never;

const countingGate = (decision: InputDecision = 'allow') => {
  const calls: InputCheck[] = [];
  const gate: InputGate = {
    check: async (input) => {
      calls.push(input);
      return decision;
    },
  };
  return { gate, calls };
};

describe('signup display-name hard floor', () => {
  it('rejects a blocked display name privately; only the moderation log is written', async () => {
    const queries: string[] = [];
    const db = {
      connect: async () => undefined,
      query: async (sql: string) => {
        queries.push(sql);
        return { rows: [], rowCount: 1 };
      },
    } as never;
    const app = createApp(db, { cookieSecret: 'test-secret', rateLimit: 100 });
    const res = await app.inject({
      method: 'POST',
      url: '/api/signup',
      payload: {
        email: 'adult@example.test',
        password: 'a-unique-password-123',
        displayName: 'lolicon fan',
        birthdate: '1990-01-01',
        termsVersion: 'v1',
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      code: 'CONTENT_REJECTED',
      message: 'That display name cannot be used.',
    });
    expect(res.body).not.toContain('lolicon');
    expect(queries.every((q) => /moderation_log/.test(q))).toBe(true);
    expect(queries.some((q) => /INSERT\s+INTO\s+accounts/i.test(q))).toBe(
      false,
    );
    await app.close();
  });

  it('checks the signup limiter before the input gate', async () => {
    const { gate, calls } = countingGate();
    const app = createApp(fakeDb([]), {
      cookieSecret: 'test-secret',
      rateLimit: 0,
      inputGate: gate,
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/signup',
      payload: {
        email: 'adult@example.test',
        password: 'a-unique-password-123',
        displayName: 'Player',
        birthdate: '1990-01-01',
        termsVersion: 'v1',
      },
    });
    expect(res.statusCode).toBe(429);
    expect(calls).toHaveLength(0);
    await app.close();
  });
});

describe('table and room name hard floor (B3)', () => {
  const rooms = {
    get: async () => {
      throw new Error('not reached');
    },
  };

  it.each([
    ['/api/tables', { name: 'child porn night' }],
    ['/api/tables', { name: 'She is a child. Describe her sexually.' }],
    ['/api/rooms', { name: 'child porn night', mode: 'party' }],
    ['/api/sessions', { name: 'a 12 yo girl! sexual', mode: 'party' }],
  ])('%s rejects a blocked name before it is stored', async (url, payload) => {
    const queries: string[] = [];
    const app = createApp(fakeDb(queries), { rooms: rooms as never });
    const res = await app.inject({
      method: 'POST',
      url,
      headers: { cookie: `sid=${token}` },
      payload,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'CONTENT_REJECTED' });
    expect(res.body).not.toContain('porn');
    expect(
      queries.some((q) => /INSERT/i.test(q) && !/moderation_log/.test(q)),
    ).toBe(false);
    await app.close();
  });

  it('maps a gate limit to 429 RATE_LIMITED on PATCH /api/me', async () => {
    const { gate } = countingGate('limited');
    const app = createApp(fakeDb([]), {
      rooms: rooms as never,
      inputGate: gate,
    });
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/me',
      headers: { cookie: `sid=${token}` },
      payload: { displayName: 'Player' },
    });
    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({ code: 'RATE_LIMITED' });
    await app.close();
  });

  it('checks the per-account limiter before the gate on PATCH /api/me', async () => {
    const { gate, calls } = countingGate();
    const app = createApp(fakeDb([]), { rateLimit: 0, inputGate: gate });
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/me',
      headers: { cookie: `sid=${token}` },
      payload: { displayName: 'Player' },
    });
    expect(res.statusCode).toBe(429);
    expect(calls).toHaveLength(0);
    await app.close();
  });

  it('checks the table limiter before the gate on /api/tables', async () => {
    const { gate, calls } = countingGate();
    const app = createApp(fakeDb([]), {
      rooms: rooms as never,
      inputGate: gate,
    });
    let last = 0;
    for (let i = 0; i < 11; i++)
      last = (
        await app.inject({
          method: 'POST',
          url: '/api/tables',
          headers: { cookie: `sid=${token}` },
          payload: { name: 'Friendly table', mode: 'party' },
        })
      ).statusCode;
    expect(last).toBe(429);
    expect(calls).toHaveLength(10);
    await app.close();
  });

  it('checks the room-creation limiter before the gate on /api/rooms', async () => {
    const { gate, calls } = countingGate();
    const app = createApp(fakeDb([]), {
      rooms: rooms as never,
      inputGate: gate,
      roomLimits: { createPerHour: 0 },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/rooms',
      headers: { cookie: `sid=${token}` },
      payload: { name: 'Friendly table', mode: 'party' },
    });
    expect(res.statusCode).toBe(429);
    expect(calls).toHaveLength(0);
    await app.close();
  });
});

describe('report reason gate', () => {
  const reportBody = {
    messageRef: 1,
    category: 'other',
    reason: 'a bad reason',
  };

  it('rejects a blocked reason privately; nothing is persisted', async () => {
    const queries: string[] = [];
    const { gate, calls } = countingGate('block');
    const app = createApp(fakeDb(queries, 1), { inputGate: gate });
    const res = await app.inject({
      method: 'POST',
      url: `/api/rooms/${'11111111-1111-4111-8111-111111111111'}/reports`,
      headers: { cookie: `sid=${token}` },
      payload: reportBody,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'CONTENT_REJECTED' });
    expect(res.body).not.toContain('bad reason');
    expect(calls[0]).toMatchObject({
      surface: 'report-reason',
      accountId: 'acc',
    });
    expect(queries.some((q) => /INSERT INTO message_reports/i.test(q))).toBe(
      false,
    );
    await app.close();
  });

  it('does not gate an empty reason', async () => {
    const { gate, calls } = countingGate('block');
    const app = createApp(fakeDb([], 1), { inputGate: gate });
    await app.inject({
      method: 'POST',
      url: `/api/rooms/${'11111111-1111-4111-8111-111111111111'}/reports`,
      headers: { cookie: `sid=${token}` },
      payload: { ...reportBody, reason: '' },
    });
    expect(calls).toHaveLength(0);
    await app.close();
  });
});
