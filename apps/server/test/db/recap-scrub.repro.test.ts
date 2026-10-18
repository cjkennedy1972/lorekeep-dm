import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalObjectStore } from '../../src/storage/objectStore.js';
import { runSweep } from '../../src/retention/sweeper.js';

const CHAR_NAME = 'Brann';
const RECAP = 'Previously on the hollow: Brann bargained with the guard at the well.';
let db: Pool;
let dir: string;

const q = async (sql: string, p: unknown[] = []) =>
  (await db.query(sql, p)).rows;

async function account(id: string) {
  await q(
    "INSERT INTO accounts(id,email,password_hash,display_name,status,is_adult,age_checked_at,terms_version,terms_accepted_at) VALUES($1,$2,'h','Acct','active',true,now(),'v1',now())",
    [id, `${id}@example.test`],
  );
}

beforeAll(async () => {
  db = new Pool({ connectionString: process.env.DATABASE_URL });
  dir = await mkdtemp(join(tmpdir(), 'recap-scrub-'));
});
afterAll(async () => {
  await db.end();
  await rm(dir, { recursive: true, force: true });
});

describe('account deletion scrubs persisted recap text (5baae77f repro)', () => {
  it('removes the deleted character name from gameState.recap.recap in snapshots', async () => {
    const gone = randomUUID();
    const heir = randomUUID();
    const session = randomUUID();
    const charId = `char_${randomUUID().slice(0, 8)}`;
    await account(gone);
    await account(heir);
    try {
      await q(
        'INSERT INTO sessions(id,owner_account_id,name,adventure_id,character_id) VALUES($1,$2,$3,$4,$5)',
        [session, gone, 'Recap', 'adventure:01-hollow-under-marrowfell', charId],
      );
      await q(
        "INSERT INTO events(session_id,seq,turn_id,type,payload) VALUES($1,1,$2,'SeatJoined',$3),($1,2,$2,'SeatJoined',$4),($1,3,$2,'GameStateCommitted',$5)",
        [
          session,
          randomUUID(),
          { seatId: randomUUID(), accountId: heir, displayName: 'Heir', presence: 'offline' },
          { seatId: randomUUID(), accountId: gone, displayName: 'Acct', presence: 'offline' },
          { gameState: { recap: { recap: RECAP, memoryHash: 'h1' } } },
        ],
      );
      await q('INSERT INTO snapshots(session_id,seq,state) VALUES($1,2,$2)', [
        session,
        {
          gameState: {
            party: { [gone]: { id: charId, name: CHAR_NAME } },
            recap: { recap: RECAP, memoryHash: 'h1' },
          },
        },
      ]);
      await q(
        "UPDATE accounts SET status='deleting', deletion_requested_at=now() WHERE id=$1",
        [gone],
      );

      const result = await runSweep(db, {
        store: new LocalObjectStore(dir),
        log: () => {},
      });
      expect(result?.accounts.failed).toBe(0);

      const [row] = await q(
        'SELECT state::text AS state FROM snapshots WHERE session_id=$1',
        [session],
      );
      expect(row.state).not.toContain(CHAR_NAME);

      const events = await q(
        "SELECT payload::text AS payload FROM events WHERE session_id=$1 AND type='GameStateCommitted'",
        [session],
      );
      for (const e of events) expect(e.payload).not.toContain(CHAR_NAME);
    } finally {
      await q('SELECT purge_session($1)', [session]);
      await q('DELETE FROM accounts WHERE id = ANY($1)', [[gone, heir]]);
    }
  });
});
