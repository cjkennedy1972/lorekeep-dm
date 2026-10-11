import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { LocalObjectStore } from '../../src/storage/objectStore.js';
import { runSweep } from '../../src/retention/sweeper.js';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
afterAll(() => pool.end());
const q = async (sql: string, p: unknown[] = []) =>
  (await pool.query(sql, p)).rows;

describe('account deletion and moderation_log', () => {
  it('nulls moderation_log.account_id and keeps the row for the retention window', async () => {
    const gone = randomUUID();
    await q(
      "INSERT INTO accounts(id,email,password_hash,display_name,status,is_adult,age_checked_at,terms_version,terms_accepted_at,deletion_requested_at) VALUES($1,$2,'h','Gone','deleting',true,now(),'v1',now(),now())",
      [gone, `${gone}@example.test`],
    );
    const logId = randomUUID();
    await q(
      `INSERT INTO moderation_log(id,surface,account_id,category,source,expires_at)
       VALUES($1,'player-action',$2,'violence','judge',now() + interval '30 days')`,
      [logId, gone],
    );
    await runSweep(pool, {
      store: new LocalObjectStore(
        await mkdtemp(join(tmpdir(), 'mod-log-del-')),
      ),
      log: () => {},
    });
    const [row] = await q(
      'SELECT account_id, expires_at > now() AS live FROM moderation_log WHERE id=$1',
      [logId],
    );
    expect(row).toEqual({ account_id: null, live: true });
  });
});
