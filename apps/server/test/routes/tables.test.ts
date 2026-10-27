import { allowInputGate } from '../support/allowInputGate.js';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { registerTableRoutes } from '../../src/routes/tables.js';
import type { InputGate } from '../../src/safety/inputGate.js';
import { quickBuild } from '@game/rules-engine';
import { loadCatalog } from '@game/rules-engine/catalog-node';

const token = 'a'.repeat(43);

function characterWithCondition(source: string) {
  return {
    ...quickBuild(loadCatalog(), 'class:fighter', 0x28, 1).character,
    id: '00000000-0000-4000-8000-000000000000',
    conditions: [{ conditionId: 'condition:poisoned', source }],
  };
}

function registerCreateTableRoute(inputGate: InputGate, calls: string[]) {
  let createdCharacter = characterWithCondition('a giant spider bite');
  const db = {
    query: async (sql: string, params?: unknown[]) => {
      calls.push(sql);
      if (/INSERT INTO sessions/.test(sql) && typeof params?.[8] === 'string')
        createdCharacter = JSON.parse(params[8]) as typeof createdCharacter;
      if (/UPDATE auth_sessions/.test(sql))
        return {
          rows: [{ account_id: 'acc', token_hash: 'h' }],
          rowCount: 1,
        };
      if (/count\(\*\)::text AS count/.test(sql))
        return { rows: [{ count: '0' }], rowCount: 1 };
      if (/SELECT id,name,status,adventure_id/.test(sql))
        return {
          rows: [
            {
              id: 'session',
              name: 'A table',
              status: 'active',
              adventure_id: 'adventure:01-hollow-under-marrowfell',
              difficulty: 'moderate',
              catalog_version: 'test',
              character: createdCharacter,
            },
          ],
          rowCount: 1,
        };
      return { rows: [], rowCount: 0 };
    },
    connect: async () => ({
      query: async (sql: string) => {
        calls.push(sql);
        if (/RETURNING id/.test(sql))
          return { rows: [{ id: 'registry-row' }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      },
      release() {},
    }),
  } as never;
  const app = createApp(
    { query: async () => ({ rows: [], rowCount: 0 }) } as never,
    { cookieSecret: 'test-secret', inputGate },
  );
  registerTableRoutes(
    app as never,
    db,
    {
      get: async () => ({
        seat: async () => {},
        persistGameState: async () => {},
      }),
    } as never,
    true,
  );
  return app;
}

function createTablePayload(source: string) {
  return {
    name: 'A table',
    character: characterWithCondition(source),
  };
}

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

  it.each(['class:fighter', 'class:wizard'])(
    'creates a %s table from a quickBuild character, replacing its client ID',
    async (classId) => {
      const calls: string[] = [];
      const app = registerCreateTableRoute(allowInputGate, calls);
      const character = quickBuild(loadCatalog(), classId, 0x28, 1).character;
      expect(character.id).not.toMatch(/^[0-9a-f-]{36}$/i);
      const response = await app.inject({
        method: 'POST',
        url: '/api/tables',
        headers: { cookie: `sid=${token}` },
        payload: { name: 'A table', character },
      });
      expect(response.statusCode).toBe(201);
      expect(response.json().game.character.classId).toBe(classId);
      expect(response.json().game.character.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
      await app.close();
    },
  );

  it('returns safe Zod paths and codes for invalid character fields', async () => {
    const calls: string[] = [];
    const app = registerCreateTableRoute(allowInputGate, calls);
    const character = characterWithCondition('a giant spider bite');
    const response = await app.inject({
      method: 'POST',
      url: '/api/tables',
      headers: { cookie: `sid=${token}` },
      payload: {
        name: 'A table',
        character: { ...character, name: '' },
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      code: 'INVALID_INPUT',
      details: [{ path: 'character.name', code: 'too_small' }],
    });
    expect(response.body).not.toContain('a giant spider bite');
    await app.close();
  });

  it('blocks a valid condition source before inserting a session', async () => {
    const calls: string[] = [];
    const checked: string[] = [];
    const app = registerCreateTableRoute(
      {
        check: async ({ text }) => {
          checked.push(text);
          return text === 'UNMODERATED_SOURCE_MARKER' ? 'block' : 'allow';
        },
      },
      calls,
    );
    const response = await app.inject({
      method: 'POST',
      url: '/api/tables',
      headers: { cookie: `sid=${token}` },
      payload: createTablePayload('UNMODERATED_SOURCE_MARKER'),
    });
    expect(checked).toContain('UNMODERATED_SOURCE_MARKER');
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'CONTENT_REJECTED' });
    expect(calls.some((sql) => /INSERT INTO sessions/.test(sql))).toBe(false);
    await app.close();
  });

  it('allows a benign source on a catalog condition and inserts the session', async () => {
    const calls: string[] = [];
    const checked: string[] = [];
    const app = registerCreateTableRoute(
      {
        check: async ({ text }) => {
          checked.push(text);
          return 'allow';
        },
      },
      calls,
    );
    const response = await app.inject({
      method: 'POST',
      url: '/api/tables',
      headers: { cookie: `sid=${token}` },
      payload: createTablePayload('a giant spider bite'),
    });
    expect(checked).toContain('a giant spider bite');
    expect(response.statusCode).toBe(201);
    expect(calls.some((sql) => /INSERT INTO sessions/.test(sql))).toBe(true);
    await app.close();
  });
});
