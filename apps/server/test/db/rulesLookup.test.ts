import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MAX_RULES_LOOKUP_CHARS,
  rulesLookup,
} from '../../src/dm/rulesLookup.js';
import { createTestDatabase, type TestDatabase } from './testDb.js';

type Corpus = {
  chunks: Array<{
    id: string;
    sectionPath: string;
    text: string;
    srdPage: number;
  }>;
};
const corpus = JSON.parse(
  await readFile(
    new URL('../../../packages/engine/srd-text/chunks.json', import.meta.url),
    'utf8',
  ),
) as Corpus;
const databaseUrl = process.env.DATABASE_URL;
let database: TestDatabase | undefined;

describe.skipIf(!databaseUrl)(
  'rules_lookup against the real SRD text index',
  () => {
    beforeAll(async () => {
      database = await createTestDatabase();
      await database.pool.query(`
      CREATE TABLE srd_text_chunks (
        id text PRIMARY KEY,
        section_path text NOT NULL,
        text text NOT NULL,
        srd_page integer NOT NULL,
        search_vector tsvector GENERATED ALWAYS AS (to_tsvector('english', section_path || ' ' || text)) STORED
      );
      CREATE INDEX srd_text_chunks_search_idx ON srd_text_chunks USING gin(search_vector);
    `);
      for (const chunk of corpus.chunks) {
        await database.pool.query(
          'INSERT INTO srd_text_chunks(id, section_path, text, srd_page) VALUES ($1, $2, $3, $4)',
          [chunk.id, chunk.sectionPath, chunk.text, chunk.srdPage],
        );
      }
    }, 30_000);

    afterAll(async () => database?.close());

    it.each([
      ['opportunity attack', /opportunity attack/i],
      ['cover', /cover/i],
      ['grapple', /grapple/i],
      ['concentration', /concentration/i],
      ['long rest', /long rest/i],
      ['death saving throw', /death saving throw/i],
      ['hiding', /hide|hiding/i],
      ['difficult terrain', /difficult terrain/i],
      ['surprise', /surprise/i],
      ['advantage', /advantage/i],
    ])(
      'finds the SRD section for %s in the top three',
      async (topic, expectedText) => {
        const results = await rulesLookup(database!.pool, topic);
        expect(results.length).toBeGreaterThan(0);
        expect(
          results
            .slice(0, 3)
            .some((result) =>
              expectedText.test(`${result.sectionPath} ${result.text}`),
            ),
        ).toBe(true);
        expect(
          results.every(
            (result) => result.sectionPath.length > 0 && result.srdPage > 0,
          ),
        ).toBe(true);
        expect(
          results.reduce((sum, result) => sum + result.text.length, 0),
        ).toBeLessThanOrEqual(MAX_RULES_LOOKUP_CHARS);
      },
    );

    it('returns a clean miss for an unknown topic', async () => {
      expect(await rulesLookup(database!.pool, 'xyzzy quantum wombat')).toEqual(
        [],
      );
    });
  },
);
