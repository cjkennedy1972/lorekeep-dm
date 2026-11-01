import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { Persistence } from '../src/persistence/index.js';

function persistenceReturning(rows: Array<{ mode: string }>) {
  const pool = {
    query: async () => ({ rows }),
  } as unknown as Pool;
  return new Persistence(pool);
}

describe('loadSessionMode', () => {
  it('refuses to infer solo mode when the session row is missing', async () => {
    await expect(
      persistenceReturning([]).loadSessionMode('missing'),
    ).rejects.toThrow('Session mode is missing or invalid');
  });

  it('refuses unknown persisted modes instead of treating them as solo', async () => {
    await expect(
      persistenceReturning([{ mode: 'unexpected' }]).loadSessionMode('session'),
    ).rejects.toThrow('Session mode is missing or invalid');
  });
});
