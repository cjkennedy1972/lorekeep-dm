import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from './testDb.js';

const migrationSql = (name: string) =>
  readFile(new URL(`../../migrations/${name}.sql`, import.meta.url), 'utf8');

describe('mature tier migration', () => {
  let database: TestDatabase;

  beforeEach(async () => {
    database = await createTestDatabase({ extraSearchPath: ['public'] });
  });

  afterEach(async () => {
    await database.close();
  });

  it('applies on a clean database with tier defaults and a CHECK on the tier', async () => {
    const names = await listMigrations();
    for (const name of names)
      await database.pool.query(await migrationSql(name));

    const columns = await database.pool.query<{
      column_name: string;
      column_default: string | null;
      is_nullable: string;
    }>(
      `SELECT column_name, column_default, is_nullable FROM information_schema.columns
       WHERE table_schema=$1 AND table_name='sessions' AND column_name IN ('moderation_verified','content_tier')
       ORDER BY column_name`,
      [database.schema],
    );
    expect(columns.rows).toEqual([
      {
        column_name: 'content_tier',
        column_default: "'standard'::text",
        is_nullable: 'NO',
      },
      {
        column_name: 'moderation_verified',
        column_default: 'false',
        is_nullable: 'NO',
      },
    ]);

    const id = randomUUID();
    await database.pool.query(
      `INSERT INTO accounts(id,email,password_hash,display_name,is_adult,age_checked_at,terms_version,terms_accepted_at)
       VALUES ($1,$2,'hash','Player',true,now(),'v1',now())`,
      [id, `${id}@example.test`],
    );
    await expect(
      database.pool.query(
        'INSERT INTO sessions(id,owner_account_id,content_tier) VALUES ($1,$1,$2)',
        [id, 'unlimited'],
      ),
    ).rejects.toThrow(/content_tier/);
  });

  it('applies over an existing M2-state database and backfills existing sessions', async () => {
    const names = await listMigrations();
    const m2 = names.filter((name) => name < '0020_');
    for (const name of m2) await database.pool.query(await migrationSql(name));

    const id = randomUUID();
    await database.pool.query(
      `INSERT INTO accounts(id,email,password_hash,display_name,is_adult,age_checked_at,terms_version,terms_accepted_at)
       VALUES ($1,$2,'hash','Player',true,now(),'v1',now())`,
      [id, `${id}@example.test`],
    );
    await database.pool.query(
      'INSERT INTO sessions(id,owner_account_id) VALUES ($1,$1)',
      [id],
    );

    await database.pool.query(await migrationSql('0020_mature_tier'));

    const row = await database.pool.query<{
      moderation_verified: boolean;
      content_tier: string;
    }>('SELECT moderation_verified, content_tier FROM sessions WHERE id=$1', [
      id,
    ]);
    expect(row.rows[0]).toEqual({
      moderation_verified: false,
      content_tier: 'standard',
    });
  });

  it('reverses cleanly with the down statement', async () => {
    const names = await listMigrations();
    for (const name of names)
      await database.pool.query(await migrationSql(name));

    await database.pool.query(
      'ALTER TABLE sessions DROP COLUMN content_tier, DROP COLUMN moderation_verified;',
    );
    const remaining = await database.pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema=$1 AND table_name='sessions' AND column_name IN ('moderation_verified','content_tier')`,
      [database.schema],
    );
    expect(remaining.rowCount).toBe(0);
  });
});

async function listMigrations(): Promise<string[]> {
  const { readdir } = await import('node:fs/promises');
  const files = await readdir(new URL('../../migrations/', import.meta.url));
  return [
    ...new Set(
      files
        .filter((f) => f.endsWith('.sql'))
        .map((f) => f.replace(/\.sql$/, '')),
    ),
  ].sort();
}
