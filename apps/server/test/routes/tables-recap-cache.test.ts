import { allowInputGate } from '../support/allowInputGate.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { registerTableRoutes } from '../../src/routes/tables.js';
import { SAFE_RECAP_FALLBACK } from '../../src/dm/recap.js';

const moderate = vi.fn(async () => ({ verdict: 'allow' }));
let recapText: string;
let revision: string;
let recapVersion: number | undefined;

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

function buildApp() {
  const db = {
    query: async (sql: string) =>
      sql.includes('operator_endpoints')
        ? { rows: [{ revision }], rowCount: 1 }
        : {
            rows: [
              {
                id: 'session-1',
                name: 'Table',
                status: 'active',
                adventure_id: 'adventure:01',
                difficulty: 'moderate',
                catalog_version: 'v1',
                last_active_at: new Date(0),
                character: { level: 1 },
                recap: { recap: recapText, provenanceVersion: recapVersion },
              },
            ],
            rowCount: 1,
          },
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
  return app;
}

async function listRecap(app: ReturnType<typeof buildApp>) {
  const response = await app.inject({ method: 'GET', url: '/api/tables' });
  expect(response.statusCode).toBe(200);
  return response.json().games[0].recap as string;
}

describe('GET /api/tables recap moderation', () => {
  beforeEach(() => {
    moderate.mockClear();
    moderate.mockImplementation(async () => ({ verdict: 'allow' }));
    recapText = 'The party entered the hollow.';
    revision = 'rev-1';
    recapVersion = 2;
  });

  it('does not serve an unmarked legacy recap even if it contains a leaked fact', async () => {
    recapVersion = undefined;
    recapText = 'The key is under the throne.';
    const app = buildApp();
    expect(await listRecap(app)).toBe('');
    expect(moderate).not.toHaveBeenCalled();
    await app.close();
  });

  it('judges a stored recap once and reuses the verdict on repeat list reads', async () => {
    const app = buildApp();
    for (let i = 0; i < 3; i++)
      expect(await listRecap(app)).toBe('The party entered the hollow.');
    expect(moderate).toHaveBeenCalledTimes(1);

    recapText = 'A different recap that must be judged.';
    await listRecap(app);
    expect(moderate).toHaveBeenCalledTimes(2);
    await app.close();
  });

  it('does not cache a judge-error fallback and shows the real recap once the judge recovers', async () => {
    moderate.mockImplementationOnce(async () => {
      throw new Error('judge unavailable');
    });
    const app = buildApp();
    expect(await listRecap(app)).toBe(SAFE_RECAP_FALLBACK);
    expect(await listRecap(app)).toBe('The party entered the hollow.');
    expect(await listRecap(app)).toBe('The party entered the hollow.');
    expect(moderate).toHaveBeenCalledTimes(2);
    await app.close();
  });

  it('re-judges cached recaps when the moderate endpoint revision changes', async () => {
    const app = buildApp();
    await listRecap(app);
    revision = 'rev-2';
    await listRecap(app);
    expect(moderate).toHaveBeenCalledTimes(2);
    await app.close();
  });
});
