import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalObjectStore } from '../../src/storage/objectStore.js';
import { runSweep } from '../../src/retention/sweeper.js';

let db: Pool;
let dir: string;

const q = async (sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows;

beforeAll(async () => {
  db = new Pool({ connectionString: process.env.DATABASE_URL });
  dir = await mkdtemp(join(tmpdir(), 'owner-rule-'));
});
afterAll(async () => {
  await db.end();
  await rm(dir, { recursive: true, force: true });
});

describe('ADR-017 owner-based account deletion rule', () => {
  it('purges an owned room whose only co-seat is not active, instead of handing it off', async () => {
    const gone = randomUUID();
    const suspended = randomUUID();
    const session = randomUUID();
    await q(
      "INSERT INTO accounts(id,email,password_hash,display_name,status,is_adult,age_checked_at,terms_version,terms_accepted_at) VALUES($1,$2,'h','Gone','active',true,now(),'v1',now()),($3,$4,'h','Sus','suspended',true,now(),'v1',now())",
      [gone, `${gone}@example.test`, suspended, `${suspended}@example.test`],
    );
    try {
      await q(
        'INSERT INTO sessions(id,owner_account_id,name,adventure_id) VALUES($1,$2,$3,$4)',
        [session, gone, 'Owner rule', 'adventure:01-hollow-under-marrowfell'],
      );
      await q(
        "INSERT INTO events(session_id,seq,turn_id,type,payload) VALUES($1,1,$2,'SeatJoined',$3),($1,2,$4,'SeatJoined',$5)",
        [
          session,
          randomUUID(),
          { seatId: randomUUID(), accountId: gone, displayName: 'Gone', presence: 'offline' },
          randomUUID(),
          { seatId: randomUUID(), accountId: suspended, displayName: 'Sus', presence: 'offline' },
        ],
      );
      await q("UPDATE accounts SET status='deleting', deletion_requested_at=now() WHERE id=$1", [gone]);
      await runSweep(db, { store: new LocalObjectStore(dir), log: () => {} });

      expect(await q('SELECT 1 FROM sessions WHERE id=$1', [session])).toHaveLength(0);
      expect(await q('SELECT 1 FROM accounts WHERE id=$1', [gone])).toHaveLength(0);
    } finally {
      await q('SELECT purge_session($1)', [session]);
      await q('DELETE FROM accounts WHERE id = ANY($1)', [[gone, suspended]]);
    }
  });
});
