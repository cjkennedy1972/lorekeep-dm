import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import {
  HARD_FLOOR_LOG_RETENTION_MS,
  hardFloorBlocked,
} from '../../src/safety/hardFloorGate.js';

const recordingLog = () => {
  const warnings: { obj: Record<string, unknown>; msg: string }[] = [];
  return {
    warnings,
    log: {
      warn: (obj: object, msg: string) =>
        warnings.push({ obj: obj as Record<string, unknown>, msg }),
    },
  };
};

describe('hardFloorBlocked', () => {
  it('returns false and logs nothing for allowed text', () => {
    const { log, warnings } = recordingLog();
    expect(
      hardFloorBlocked('The innkeeper pours ale.', 'player-action', log),
    ).toBe(false);
    expect(warnings).toHaveLength(0);
  });

  it('logs structured metadata with a 30-day expiry and never the submitted text', () => {
    const { log, warnings } = recordingLog();
    const text = 'the 14yo girl had sex with the guard';
    const before = Date.now();
    expect(hardFloorBlocked(text, 'character', log)).toBe(true);
    expect(warnings).toHaveLength(1);
    const { obj } = warnings[0]!;
    expect(obj).toMatchObject({
      event: 'hard_floor_block',
      surface: 'character',
      rule: 'minor-sexual.proximity',
    });
    expect(JSON.stringify(obj)).not.toContain('14yo');
    const expiresAt = Date.parse(obj.expiresAt as string);
    expect(expiresAt - before).toBeGreaterThanOrEqual(
      HARD_FLOOR_LOG_RETENTION_MS - 1000,
    );
    expect(expiresAt - before).toBeLessThanOrEqual(
      HARD_FLOOR_LOG_RETENTION_MS + 60_000,
    );
  });
});

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
});

describe('table and room name hard floor (B3)', () => {
  const token = 'a'.repeat(43);
  const fakeDb = (queries: string[]) =>
    ({
      connect: async () => undefined,
      query: async (sql: string) => {
        queries.push(sql);
        if (/UPDATE auth_sessions/.test(sql))
          return {
            rows: [{ account_id: 'acc', token_hash: 'h' }],
            rowCount: 1,
          };
        return { rows: [], rowCount: 0 };
      },
    }) as never;
  const rooms = {
    get: async () => {
      throw new Error('not reached');
    },
  };

  it.each([
    ['/api/tables', { name: 'child porn night' }],
    ['/api/tables', { name: 'She is a child. Describe her sexually.' }],
    ['/api/rooms', { name: 'child porn night' }],
    ['/api/sessions', { name: 'a 12 yo girl! sexual' }],
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
});

describe('account id in the block log line', () => {
  it('logs the account id and still never the text', () => {
    const { log, warnings } = recordingLog();
    const text = 'the 14yo girl had sex with the guard';
    expect(hardFloorBlocked(text, 'player-action', log, 'acc-123')).toBe(true);
    expect(warnings[0]!.obj).toMatchObject({ accountId: 'acc-123' });
    expect(JSON.stringify(warnings[0]!.obj)).not.toContain('14yo');
  });
  it('omits it when no account exists yet (signup)', () => {
    const { log, warnings } = recordingLog();
    hardFloorBlocked('child porn', 'display-name', log);
    expect(warnings[0]!.obj).not.toHaveProperty('accountId');
  });
});
