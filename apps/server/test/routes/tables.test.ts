import { allowInputGate } from '../support/allowInputGate.js';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { registerTableRoutes } from '../../src/routes/tables.js';

describe('solo table lifecycle routes', () => {
  it('requires an authenticated verified account before parsing or reading tables', async () => {
    const calls: string[] = [];
    const db = {
      connect: async () => ({
        query: async () => ({ rows: [], rowCount: 0 }),
        release() {},
      }),
      query: async (sql: string) => {
        calls.push(sql);
        return { rows: [], rowCount: 0 };
      },
    } as never;
    const app = createApp(
      {
        query: async (sql: string) => {
          calls.push(sql);
          return { rows: [], rowCount: 0 };
        },
      } as never,
      { cookieSecret: 'test-secret', inputGate: allowInputGate },
    );
    registerTableRoutes(
      app as never,
      db,
      {
        get: async () => {
          throw new Error('not reached');
        },
      } as never,
      true,
    );
    const response = await app.inject({ method: 'GET', url: '/api/tables' });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(calls).toHaveLength(0);
    await app.close();
  });
});
