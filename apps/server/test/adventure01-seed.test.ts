import { describe, expect, test, vi } from 'vitest';
import { adventure01RegistrySeed } from '@game/rules-engine/adventure-node';
import { RegistryMemory } from '../src/dm/memory.js';

describe('Adventure #1 registry seed persistence', () => {
  test('loads all seed entities through the new-table upsert API', async () => {
    const calls: unknown[][] = [];
    const client = {
      query: vi.fn(async (...args: unknown[]) => {
        calls.push(args);
        const query = String(args[0] ?? '');
        if (query.includes('SELECT id, version, payload'))
          return { rowCount: 0, rows: [] };
        if (query.includes('RETURNING id'))
          return { rowCount: 1, rows: [{ id: String(calls.length) }] };
        return { rowCount: 1, rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = {
      connect: vi.fn(async () => client),
      query: client.query,
    } as never;
    await new RegistryMemory(pool).upsertMany(
      'fresh-table',
      adventure01RegistrySeed(),
    );
    expect(calls[0]?.[0]).toBe('BEGIN');
    expect(
      calls.filter((call) =>
        String(call[0]).includes('INSERT INTO registry_entries'),
      ),
    ).toHaveLength(10);
    expect(calls.at(-1)?.[0]).toBe('COMMIT');
    expect(client.release).toHaveBeenCalledOnce();
  });
});
