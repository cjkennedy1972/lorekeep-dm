import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RegistryMemory } from '../../src/dm/memory.js';
import { boundSummary, summarizeScene } from '../../src/dm/summarize.js';
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

  it('summaries rebuilt from the event log equal stored ones in replay mode', async () => {
    const events = [
      { type: 'LocationUpserted', payload: { name: 'The silver archive' } },
      { type: 'QuestUpdated', payload: { summary: 'The archive is secured.' } },
    ];
    await database!.pool.query(
      'INSERT INTO events(session_id,seq,turn_id,type,payload) VALUES($1,1,$2,$3,$4::jsonb),($1,2,$5,$6,$7::jsonb)',
      [
        sessionId,
        '00000000-0000-4000-8000-000000000028',
        events[0]!.type,
        JSON.stringify(events[0]!.payload),
        '00000000-0000-4000-8000-000000000029',
        events[1]!.type,
        JSON.stringify(events[1]!.payload),
      ],
    );
    const log = await database!.pool.query<{
      type: string;
      payload: Record<string, unknown>;
    }>('SELECT type,payload FROM events WHERE session_id=$1 ORDER BY seq', [
      sessionId,
    ]);
    const replay = async () =>
      (
        await summarizeScene({
          sceneId: 'replay-scene',
          events: log.rows.map((event) => ({
            type: event.type,
            payload: event.payload,
          })),
          adapter: {
            async *complete() {
              yield { type: 'text' as const, delta: 'not JSON' };
            },
          },
        })
      ).summary;
    await memory.closeScene(sessionId, 'replay-scene', await replay());
    const stored = await database!.pool.query<{ id: string; summary: string }>(
      'SELECT id,summary FROM scene_summaries WHERE session_id=$1 AND scene_id=$2',
      [sessionId, 'replay-scene'],
    );
    expect(await replay()).toBe(stored.rows[0]?.summary);
  });
});
