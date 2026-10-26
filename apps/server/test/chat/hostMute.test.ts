import { describe, expect, it } from 'vitest';
import { applyHostChatMute } from '../../src/chat/mutes.js';

function fakeDb(failDeletes: boolean) {
  const log: string[] = [];
  return {
    log,
    db: {
      query: async (sql: string) => {
        const op = sql.trim().split(/\s/)[0]!;
        log.push(op);
        if (op === 'DELETE' && failDeletes) throw new Error('db down');
        return { rows: [], rowCount: 0 };
      },
    } as never,
  };
}

describe('applyHostChatMute unmute ordering', () => {
  it('appends before deleting and lifts policy only after both commit', async () => {
    const { db, log } = fakeDb(false);
    await applyHostChatMute(
      db,
      's',
      'a',
      false,
      'x',
      async () => void log.push('append'),
      undefined,
      () => log.push('lift'),
    );
    expect(log).toEqual(['append', 'DELETE', 'lift']);
  });
  it('failed append deletes nothing and does not lift', async () => {
    const { db, log } = fakeDb(false);
    await expect(
      applyHostChatMute(
        db,
        's',
        'a',
        false,
        'x',
        () => Promise.reject(new Error('append')),
        undefined,
        () => log.push('lift'),
      ),
    ).rejects.toThrow('append');
    expect(log).toEqual([]);
  });
  it('failed row delete rejects without lifting the policy', async () => {
    const { db, log } = fakeDb(true);
    await expect(
      applyHostChatMute(
        db,
        's',
        'a',
        false,
        'x',
        async () => void log.push('append'),
        undefined,
        () => log.push('lift'),
      ),
    ).rejects.toThrow('db down');
    expect(log).not.toContain('lift');
  });
});
