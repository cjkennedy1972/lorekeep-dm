import { describe, expect, it, vi } from 'vitest';
import {
  retentionHealth,
  STALE_AFTER_MS,
} from '../../src/retention/sweeper.js';
import { skipIfHeld } from '../../src/retention/types.js';

const dbWith = (last?: Date) =>
  ({
    query: async () => ({ rows: last ? [{ last_completed_at: last }] : [] }),
  }) as never;

describe('retention health (fake clock)', () => {
  const now = new Date('2026-10-06T12:00:00Z');
  it('is stale when never run', async () => {
    expect((await retentionHealth(dbWith(), now)).stale).toBe(true);
  });
  it('is fresh at 26h and stale just past 26h', async () => {
    const at = (ms: number) => new Date(now.getTime() - ms);
    expect((await retentionHealth(dbWith(at(STALE_AFTER_MS)), now)).stale).toBe(
      false,
    );
    expect(
      (await retentionHealth(dbWith(at(STALE_AFTER_MS + 1)), now)).stale,
    ).toBe(true);
  });
});

describe('legal-hold stub', () => {
  it('skips held items, audits and logs ids only', async () => {
    const queries: string[] = [];
    const log = vi.fn();
    const db = {
      query: async (sql: string) => {
        queries.push(sql);
        return { rowCount: sql.startsWith('SELECT') ? 1 : 1 };
      },
    };
    const held = await skipIfHeld(
      { db, log, now: new Date(), store: {} as never } as never,
      'exports',
      'export',
      'id-1',
    );
    expect(held).toBe(true);
    expect(queries.some((q) => q.includes('retention_audit'))).toBe(true);
    expect(log).toHaveBeenCalledWith({
      job: 'exports',
      event: 'skipped_legal_hold',
      kind: 'export',
      id: 'id-1',
    });
  });
});
