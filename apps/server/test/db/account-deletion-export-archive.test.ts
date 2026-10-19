import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { LocalObjectStore } from '../../src/storage/objectStore.js';
import { runSweep } from '../../src/retention/sweeper.js';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
afterAll(() => pool.end());
const log = () => {};
const q = async (sql: string, p: unknown[] = []) =>
  (await pool.query(sql, p)).rows;

describe('account deletion removes export archives', () => {
  it('deleting the account deletes its archive file and export row', async () => {
    const gone = randomUUID();
    await q(
      "INSERT INTO accounts(id,email,password_hash,display_name,status,is_adult,age_checked_at,terms_version,terms_accepted_at,deletion_requested_at) VALUES($1,$2,'h','ArchiveGone','deleting',true,now(),'v1',now(),now())",
      [gone, `${gone}@example.test`],
    );
    const exportId = randomUUID();
    const dir = await mkdtemp(join(tmpdir(), 'acct-export-archive-'));
    const store = new LocalObjectStore(dir);
    await store.put(`${exportId}.json`, '{}');
    await q(
      "INSERT INTO export_jobs(id,account_id,status,expires_at,archive_key) VALUES($1,$2,'completed',now() + interval '1 day',$3)",
      [exportId, gone, `${exportId}.json`],
    );

    await runSweep(pool, { store, log });

    expect(await readdir(dir)).toEqual([]);
    expect(
      await q('SELECT 1 FROM export_jobs WHERE id=$1', [exportId]),
    ).toEqual([]);
    expect(await q('SELECT 1 FROM accounts WHERE id=$1', [gone])).toEqual([]);
  });
});
