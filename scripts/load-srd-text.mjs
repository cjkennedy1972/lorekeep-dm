import console from 'node:console';
import process from 'node:process';
import { URL } from 'node:url';
import { readFile } from 'node:fs/promises';
import pg from 'pg';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const corpus = JSON.parse(
  await readFile(
    new URL('../packages/engine/srd-text/chunks.json', import.meta.url),
    'utf8',
  ),
);
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  await client.query('BEGIN');
  await client.query('TRUNCATE srd_text_chunks, srd_text_metadata');
  await client.query(
    'INSERT INTO srd_text_metadata(singleton, attribution, source_url, source_sha256, regenerated_by) VALUES (true, $1, $2, $3, $4)',
    [
      corpus.metadata.attribution,
      corpus.metadata.source,
      corpus.metadata.sourceSha256,
      corpus.metadata.regeneratedBy,
    ],
  );
  for (const chunk of corpus.chunks) {
    await client.query(
      'INSERT INTO srd_text_chunks(id, section_path, text, srd_page) VALUES ($1, $2, $3, $4)',
      [chunk.id, chunk.sectionPath, chunk.text, chunk.srdPage],
    );
  }
  await client.query('COMMIT');
  console.log(`Loaded ${corpus.chunks.length} SRD chunks`);
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  await client.end();
}
