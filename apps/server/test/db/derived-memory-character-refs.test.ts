import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ensureSessionCharacterToken,
  getIndexedDerivedMemoryRows,
  indexDerivedMemoryRow,
  reconcileDerivedMemoryCharacterRefs,
} from '../../src/dm/characterReferences.js';
import { createTestDatabase, type TestDatabase } from './testDb.js';

const databaseUrl = process.env.DATABASE_URL;
describe.skipIf(!databaseUrl)(
  'derived-memory character reference migration',
  () => {
    let db: TestDatabase;
    const sessionId = randomUUID();
    const characterId = randomUUID();
    beforeAll(async () => {
      db = await createTestDatabase({ extraSearchPath: ['public'] });
      await db.pool.query('CREATE TABLE sessions (id uuid PRIMARY KEY)');
      await db.pool.query('INSERT INTO sessions VALUES ($1)', [sessionId]);
      await db.pool.query(
        await readFile(
          new URL('../../migrations/0014_registry.sql', import.meta.url),
          'utf8',
        ),
      );
      await db.pool.query(
        await readFile(
          new URL(
            '../../migrations/0030_scene_summary_turn_link.sql',
            import.meta.url,
          ),
          'utf8',
        ),
      );
      await db.pool.query(
        await readFile(
          new URL(
            '../../migrations/0031_registry_turn_link.sql',
            import.meta.url,
          ),
          'utf8',
        ),
      );
      await db.pool.query(
        'INSERT INTO scene_summaries(session_id,scene_id,summary) VALUES ($1,$2,$3)',
        [sessionId, 'legacy', 'legacy text untouched'],
      );
      await db.pool.query(
        await readFile(
          new URL(
            '../../migrations/0045_derived_memory_character_refs.sql',
            import.meta.url,
          ),
          'utf8',
        ),
      );
    });
    afterAll(async () => db?.close());

    it('adds constraints/indexes transactionally without changing legacy data and remains old-code compatible', async () => {
      expect(
        (
          await db.pool.query(
            'SELECT summary FROM scene_summaries WHERE scene_id=$1',
            ['legacy'],
          )
        ).rows[0].summary,
      ).toBe('legacy text untouched');
      const indexes = await db.pool.query(
        `SELECT indexname FROM pg_indexes WHERE schemaname=current_schema() AND tablename='derived_memory_character_refs'`,
      );
      expect(indexes.rows.map((row) => row.indexname)).toEqual(
        expect.arrayContaining([
          'derived_memory_character_refs_pkey',
          'derived_memory_character_refs_lookup_idx',
          'derived_memory_character_refs_row_idx',
        ]),
      );
      const token = await ensureSessionCharacterToken(
        db.pool,
        sessionId,
        characterId,
      );
      expect(token).toMatch(/^[A-Za-z0-9_-]{32,}$/);
      expect(
        await ensureSessionCharacterToken(db.pool, sessionId, characterId),
      ).toBe(token);
      await expect(
        db.pool.query(
          'INSERT INTO session_character_tokens VALUES ($1,$2,$3)',
          [sessionId, randomUUID(), token],
        ),
      ).rejects.toThrow();
      await expect(
        db.pool.query(
          'INSERT INTO session_character_tokens VALUES ($1,$2,$3)',
          [randomUUID(), randomUUID(), 'a'.repeat(32)],
        ),
      ).rejects.toThrow();
      await db.pool.query('SELECT summary FROM scene_summaries');
      const down = await import(
        '../../migrations/0045_derived_memory_character_refs.js'
      );
      down.down({
        sql: (statement: string) => {
          throw new Error(`unexpected destructive rollback: ${statement}`);
        },
      });
      expect(
        (
          await db.pool.query(
            "SELECT to_regclass('session_character_tokens') AS name",
          )
        ).rows[0].name,
      ).not.toBeNull();
    });

    it('writes indexes with the row transaction and resumes idempotent reconciliation from a checkpoint', async () => {
      const client = await db.pool.connect();
      let summaryId = '';
      let token = '';
      try {
        await client.query('BEGIN');
        token = await ensureSessionCharacterToken(
          client,
          sessionId,
          characterId,
        );
        const summary = await client.query<{ id: string }>(
          `INSERT INTO scene_summaries(session_id,scene_id,summary) VALUES ($1,'token-summary',$2) RETURNING id`,
          [sessionId, `memory ${token}`],
        );
        summaryId = summary.rows[0]!.id;
        await indexDerivedMemoryRow(
          client,
          sessionId,
          'scene_summary',
          summaryId,
          [characterId],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
      const entry = await db.pool.query<{ id: string }>(
        `INSERT INTO registry_entries(session_id,entity_type,entity_id,version,name,payload,search_document) VALUES ($1,'npc','npc-1',1,'NPC','{}','') RETURNING id`,
        [sessionId],
      );
      await db.pool.query(
        'INSERT INTO registry_facts(entry_id,fact) VALUES ($1,$2)',
        [entry.rows[0]!.id, `fact ${token}`],
      );

      const first = await reconcileDerivedMemoryCharacterRefs(db.pool, null, 1);
      expect(first.processed).toBe(1);
      const resumed = await reconcileDerivedMemoryCharacterRefs(
        db.pool,
        first.checkpoint,
        1,
      );
      expect(resumed.processed).toBe(1);
      await reconcileDerivedMemoryCharacterRefs(db.pool, first.checkpoint, 1);
      const indexed = await getIndexedDerivedMemoryRows(
        db.pool,
        sessionId,
        characterId,
        true,
      );
      expect(indexed).toEqual(
        expect.arrayContaining([
          { rowKind: 'scene_summary', rowId: summaryId },
          { rowKind: 'registry_entry', rowId: entry.rows[0]!.id },
        ]),
      );
      const referencedFacts = await db.pool.query(
        `SELECT fact.id FROM derived_memory_character_refs reference
           JOIN registry_entries entry ON reference.row_kind='registry_entry' AND reference.row_id=entry.id
           JOIN registry_facts fact ON fact.entry_id=entry.id
          WHERE reference.session_id=$1 AND reference.character_id=$2 AND entry.id=$3`,
        [sessionId, characterId, entry.rows[0]!.id],
      );
      expect(referencedFacts.rowCount).toBe(1);
      await expect(
        getIndexedDerivedMemoryRows(db.pool, sessionId, characterId, false),
      ).rejects.toThrow(/coverage is unverified/);
    });
  },
);
