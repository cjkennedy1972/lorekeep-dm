import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ensureSessionCharacterToken,
  getIndexedDerivedMemoryRows,
  indexDerivedMemoryRow,
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
        `CREATE TABLE legal_holds (kind text NOT NULL, item_id text NOT NULL, PRIMARY KEY(kind,item_id))`,
      );
      await db.pool.query(
        `CREATE TABLE session_seat_characters (session_id uuid NOT NULL, seat_id uuid NOT NULL, character_id uuid NOT NULL, binding_status text NOT NULL DEFAULT 'active')`,
      );
      await db.pool.query(
        `INSERT INTO session_seat_characters(session_id,seat_id,character_id) VALUES ($1,$2,$3)`,
        [sessionId, randomUUID(), characterId],
      );
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
      expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);
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
          [sessionId, randomUUID(), 'a'.repeat(33)],
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
      let finalBatch = resumed;
      while (!finalBatch.complete)
        finalBatch = await reconcileDerivedMemoryCharacterRefs(
          db.pool,
          finalBatch.checkpoint,
          1,
        );
      const indexed = await getIndexedDerivedMemoryRows(
        db.pool,
        sessionId,
        characterId,
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
    });

    it('computes coverage and refuses a partially reconciled session, then accepts full coverage', async () => {
      const partialSession = randomUUID();
      const partialCharacter = randomUUID();
      await db.pool.query('INSERT INTO sessions VALUES ($1)', [partialSession]);
      await db.pool.query(
        'INSERT INTO session_seat_characters(session_id,seat_id,character_id) VALUES ($1,$2,$3)',
        [partialSession, randomUUID(), partialCharacter],
      );
      const partialToken = await ensureSessionCharacterToken(
        db.pool,
        partialSession,
        partialCharacter,
      );
      await db.pool.query(
        'INSERT INTO scene_summaries(session_id,scene_id,summary) VALUES ($1,$2,$3),($1,$4,$5)',
        [partialSession, 'p1', partialToken, 'p2', 'unreferenced'],
      );
      const partial = await reconcileDerivedMemoryCharacterRefs(
        db.pool,
        null,
        1,
      );
      expect(partial.complete).toBe(false);
      await expect(
        reconcileDerivedMemoryCharacterRefs(
          db.pool,
          {
            sessionId: partialSession,
            rowKind: 'scene_summary',
            rowId: '999999999',
          },
          1,
        ),
      ).rejects.toThrow(/checkpoint does not match durable state/i);
      await expect(
        getIndexedDerivedMemoryRows(db.pool, partialSession, partialCharacter),
      ).rejects.toThrow(/unverified|incomplete/i);
      let done = partial;
      while (!done.complete)
        done = await reconcileDerivedMemoryCharacterRefs(
          db.pool,
          done.checkpoint,
          1,
        );
      const fullCoverage = await getIndexedDerivedMemoryRows(
        db.pool,
        partialSession,
        partialCharacter,
      );
      expect(fullCoverage).toHaveLength(1);
      await db.pool.query(
        'DELETE FROM derived_memory_character_refs WHERE session_id=$1 AND character_id=$2 AND row_kind=$3 AND row_id=$4',
        [
          partialSession,
          partialCharacter,
          fullCoverage[0]!.rowKind,
          fullCoverage[0]!.rowId,
        ],
      );
      await expect(
        getIndexedDerivedMemoryRows(db.pool, partialSession, partialCharacter),
      ).rejects.toThrow(/coverage is incomplete/i);
      const unmappedCharacter = randomUUID();
      await db.pool.query(
        `INSERT INTO derived_memory_character_refs(session_id,character_id,row_kind,row_id)
         SELECT $1,$2,'scene_summary',id FROM scene_summaries WHERE session_id=$1 LIMIT 1`,
        [partialSession, unmappedCharacter],
      );
      await expect(
        getIndexedDerivedMemoryRows(db.pool, partialSession, unmappedCharacter),
      ).rejects.toThrow(/coverage is incomplete/i);
    });

    it('refuses to mint a token for a held session before writing', async () => {
      const heldSession = randomUUID();
      await db.pool.query('INSERT INTO sessions VALUES ($1)', [heldSession]);
      await db.pool.query("INSERT INTO legal_holds VALUES ('session',$1)", [
        heldSession,
      ]);
      await expect(
        ensureSessionCharacterToken(db.pool, heldSession, randomUUID()),
      ).rejects.toThrow(/held/i);
      expect(
        (
          await db.pool.query(
            'SELECT 1 FROM session_character_tokens WHERE session_id=$1',
            [heldSession],
          )
        ).rowCount,
      ).toBe(0);
    });

    it('does not reconcile references in held sessions', async () => {
      const heldSession = randomUUID();
      const heldCharacter = randomUUID();
      await db.pool.query('INSERT INTO sessions VALUES ($1)', [heldSession]);
      await db.pool.query("INSERT INTO legal_holds VALUES ('session',$1)", [
        heldSession,
      ]);
      await db.pool.query(
        'INSERT INTO session_character_tokens(session_id,character_id,token) VALUES ($1,$2,$3)',
        [heldSession, heldCharacter, 'H'.repeat(32)],
      );
      await db.pool.query(
        'INSERT INTO scene_summaries(session_id,scene_id,summary) VALUES ($1,$2,$3)',
        [heldSession, 'held-token', `held ${'H'.repeat(32)}`],
      );
      const heldRow = await db.pool.query<{ id: string }>(
        'INSERT INTO scene_summaries(session_id,scene_id,summary) VALUES ($1,$2,$3) RETURNING id',
        [heldSession, 'held-dual-write', 'must not be indexed'],
      );
      const heldClient = await db.pool.connect();
      try {
        await heldClient.query('BEGIN');
        await expect(
          indexDerivedMemoryRow(
            heldClient,
            heldSession,
            'scene_summary',
            heldRow.rows[0]!.id,
            [heldCharacter],
          ),
        ).rejects.toThrow(/held/i);
        await heldClient.query('ROLLBACK');
      } finally {
        heldClient.release();
      }
      await reconcileDerivedMemoryCharacterRefs(db.pool, null, 500);
      expect(
        (
          await db.pool.query(
            'SELECT 1 FROM derived_memory_character_refs WHERE session_id=$1',
            [heldSession],
          )
        ).rowCount,
      ).toBe(0);
    });

    it('matches exact boundary tokens including a plural suffix without matching longer opaque strings', async () => {
      const token = await ensureSessionCharacterToken(
        db.pool,
        sessionId,
        characterId,
      );
      const bodies = [
        [`at-start ${randomUUID()}`, `${token} starts`],
        [`at-end ${randomUUID()}`, `ends ${token}`],
        [`punctuation ${randomUUID()}`, `(${token}),`],
        [`plural ${randomUUID()}`, `plural ${token}s acted`],
        [`long-prefix ${randomUUID()}`, `x${token}`],
        [`long-suffix ${randomUUID()}`, `${token}x`],
      ];
      const ids: string[] = [];
      for (const [sceneId, body] of bodies) {
        const row = await db.pool.query<{ id: string }>(
          'INSERT INTO scene_summaries(session_id,scene_id,summary) VALUES ($1,$2,$3) RETURNING id',
          [sessionId, sceneId, body],
        );
        ids.push(row.rows[0]!.id);
      }
      await reconcileDerivedMemoryCharacterRefs(db.pool, null, 500);
      const indexed = await db.pool.query<{ row_id: string }>(
        'SELECT row_id FROM derived_memory_character_refs WHERE session_id=$1 AND character_id=$2 AND row_id=ANY($3::bigint[])',
        [sessionId, characterId, ids],
      );
      expect(indexed.rows.map(({ row_id }) => row_id).sort()).toEqual(
        ids.slice(0, 4).sort(),
      );
    });

    it('refuses to mint a token unless the character has an active session seat binding', async () => {
      await expect(
        ensureSessionCharacterToken(db.pool, sessionId, randomUUID()),
      ).rejects.toThrow(/binding/i);
    });
  },
);
