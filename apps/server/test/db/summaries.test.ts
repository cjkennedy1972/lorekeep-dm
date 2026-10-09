import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RegistryMemory } from '../../src/dm/memory.js';
import { createTestDatabase, type TestDatabase } from './testDb.js';

const databaseUrl = process.env.DATABASE_URL;
const sessionId = '00000000-0000-4000-8000-000000000027';
let database: TestDatabase | undefined;
let memory: RegistryMemory;

describe.skipIf(!databaseUrl)('durable scene summaries', () => {
  beforeAll(async () => {
    database = await createTestDatabase({ extraSearchPath: ['public'] });
    await database.pool.query('CREATE TABLE sessions (id uuid PRIMARY KEY)');
    await database.pool.query(`CREATE TABLE events (
      session_id uuid NOT NULL REFERENCES sessions(id),
      seq bigint NOT NULL,
      turn_id uuid NOT NULL,
      type text NOT NULL,
      payload jsonb NOT NULL,
      ts timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz,
      PRIMARY KEY (session_id, seq)
    )`);
    await database.pool.query('INSERT INTO sessions(id) VALUES ($1)', [
      sessionId,
    ]);
    await database.pool.query(
      await readFile(
        new URL('../../migrations/0014_registry.sql', import.meta.url),
        'utf8',
      ),
    );
    await database.pool.query(
      await readFile(
        new URL(
          '../../migrations/0015_scene_summary_idempotency.sql',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    memory = new RegistryMemory(database.pool);
  }, 30_000);
  afterAll(async () => database?.close());

  it('is append-only/idempotent, bounded, and builds recap inputs after raw events are deleted', async () => {
    expect(
      await memory.closeScene(
        sessionId,
        'scene-1',
        'The party secured the silver archive.',
      ),
    ).toBe(true);
    expect(
      await memory.closeScene(sessionId, 'scene-1', 'A duplicate close.'),
    ).toBe(false);
    await expect(
      memory.closeScene(sessionId, 'scene-2', 'x'.repeat(1201)),
    ).rejects.toThrow(/1200/);
    await database!.pool.query(
      "INSERT INTO events(session_id,seq,turn_id,type,payload,expires_at) VALUES($1,1,$1,'Transcript','{}',now())",
      [sessionId],
    );
    await database!.pool.query('DELETE FROM events WHERE session_id=$1', [
      sessionId,
    ]);
    const recapMemory = await memory.loadRecapMemory(sessionId);
    expect(recapMemory).toEqual([
      'Scene scene-1: The party secured the silver archive.',
    ]);
    const rows = await database!.pool.query(
      'SELECT id, scene_id, summary FROM scene_summaries WHERE session_id=$1',
      [sessionId],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({
      scene_id: 'scene-1',
      summary: 'The party secured the silver archive.',
    });
  });
});
