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
  it('rejects a blocked display name privately before any database access', async () => {
    let calls = 0;
    const db = {
      connect: async () => {
        calls++;
        throw new Error('database accessed');
      },
      query: async () => {
        calls++;
        throw new Error('database accessed');
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
    expect(calls).toBe(0);
    await app.close();
  });
});
