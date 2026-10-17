import { allowInputGate } from '../support/allowInputGate.js';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { registerTableRoutes } from '../../src/routes/tables.js';

const token = 'a'.repeat(43);

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

  it('rejects an unknown condition id before any database write', async () => {
    const calls: string[] = [];
    const db = {
      query: async (sql: string) => {
        calls.push(sql);
        if (/UPDATE auth_sessions/.test(sql))
          return {
            rows: [{ account_id: 'acc', token_hash: 'h' }],
            rowCount: 1,
          };
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
      { get: async () => null } as never,
      true,
    );
    const response = await app.inject({
      method: 'POST',
      url: '/api/tables',
      headers: { cookie: `sid=${token}` },
      payload: {
        name: 'A table',
        character: {
          id: '00000000-0000-4000-8000-000000000000',
          name: 'Mira',
          speciesId: 'species:human',
          classId: 'class:fighter',
          backgroundId: 'background:guard',
          level: 1,
          abilities: { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 },
          proficiencies: { skills: [], saves: [], tools: [] },
          equipment: [],
          spellsKnown: [],
          spellsPrepared: [],
          slots: {},
          hp: { current: 10, max: 10, temp: 0 },
          conditions: [
            {
              conditionId: 'condition:loli',
              source: 'UNMODERATED_SOURCE_MARKER',
            },
          ],
        },
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'INVALID_CHARACTER' });
    expect(calls.some((sql) => /INSERT INTO sessions/.test(sql))).toBe(false);
    await app.close();
  });
});
