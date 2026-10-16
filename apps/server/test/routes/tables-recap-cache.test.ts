import { allowInputGate } from '../support/allowInputGate.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { registerTableRoutes } from '../../src/routes/tables.js';

const moderate = vi.fn(async () => ({ verdict: 'allow' }));

vi.mock('../../src/middleware/auth.js', () => ({
  authenticateRequest: async () => ({ account_id: 'acct-1' }),
}));
vi.mock('../../src/safety/tierLoader.js', () => ({
  loadContentTierState: async () => ({ tier: 'standard' }),
  loadSeatedContentBoundaries: async () => ({ lines: [], veils: [] }),
}));
vi.mock('../../src/safety/inputGate.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/safety/inputGate.js')>()),
  createEndpointJudge: () => ({ moderate }),
}));

function rows(recap: string) {
  return [
    {
      id: 'session-1',
      name: 'Table',
      status: 'active',
      adventure_id: 'adventure:01',
      difficulty: 'moderate',
      catalog_version: 'v1',
      last_active_at: new Date(0),
      character: { level: 1 },
      recap: { recap },
    },
  ];
}

describe('GET /api/tables recap moderation', () => {
  let current: ReturnType<typeof rows>;

  beforeEach(() => {
    moderate.mockClear();
    current = rows('The party entered the hollow.');
  });

  it('judges a stored recap once and reuses the verdict on repeat list reads', async () => {
    const db = {
      query: async () => ({ rows: current, rowCount: current.length }),
    } as never;
    const app = createApp(db, {
      cookieSecret: 'test-secret',
      inputGate: allowInputGate,
    });
    registerTableRoutes(
      app as never,
      db,
      { get: async () => undefined } as never,
      true,
    );

    for (let i = 0; i < 3; i++) {
      const response = await app.inject({ method: 'GET', url: '/api/tables' });
      expect(response.statusCode).toBe(200);
      expect(response.json().games[0].recap).toBe(
        'The party entered the hollow.',
      );
    }
    expect(moderate).toHaveBeenCalledTimes(1);

    current = rows('A different recap that must be judged.');
    await app.inject({ method: 'GET', url: '/api/tables' });
    expect(moderate).toHaveBeenCalledTimes(2);
    await app.close();
  });
});
