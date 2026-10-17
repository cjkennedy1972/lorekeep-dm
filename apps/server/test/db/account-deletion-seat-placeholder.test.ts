import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalObjectStore } from '../../src/storage/objectStore.js';
import { runSweep } from '../../src/retention/sweeper.js';
import { loadSeatedMatureOptOuts } from '../../src/safety/tierLoader.js';

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
  dir = await mkdtemp(join(tmpdir(), 'seat-placeholder-'));
});
afterAll(async () => {
  await db.end();
  await rm(dir, { recursive: true, force: true });
});

describe('account deletion redacts seat linkage without reusing seat ids as placeholders', () => {
  it('leaves current and revoked seats unlinked from any account and fails closed for mature', async () => {
    const gone = randomUUID();
    const heir = randomUUID();
    const session = randomUUID();
    const currentSeat = randomUUID();
    const revokedSeat = randomUUID();
    await account(gone);
    await account(heir);
    try {
      await q(
        'INSERT INTO sessions(id,owner_account_id,name,adventure_id,character_id) VALUES($1,$2,$3,$4,$5)',
        [
          session,
          heir,
          'Seats',
          'adventure:01-hollow-under-marrowfell',
          `char_${randomUUID().slice(0, 8)}`,
        ],
      );
      await q(
        "INSERT INTO events(session_id,seq,turn_id,type,payload) VALUES($1,1,$2,'SeatJoined',$3),($1,2,$2,'SeatJoined',$4),($1,3,$2,'SeatJoined',$5),($1,4,$2,'SeatRevoked',$6)",
        [
          session,
          randomUUID(),
          {
            seatId: randomUUID(),
            accountId: heir,
            displayName: 'Heir',
            presence: 'offline',
          },
          {
            seatId: currentSeat,
            accountId: gone,
            displayName: 'Acct',
            presence: 'offline',
          },
          {
            seatId: revokedSeat,
            accountId: gone,
            displayName: 'Acct',
            presence: 'offline',
          },
          { seatId: revokedSeat, accountId: gone },
        ],
      );
      await q(
        "UPDATE accounts SET status='deleting', deletion_requested_at=now() WHERE id=$1",
        [gone],
      );

      const result = await runSweep(db, {
        store: new LocalObjectStore(dir),
        log: () => {},
      });
      expect(result?.accounts.failed).toBe(0);
      expect(
        await q('SELECT 1 FROM accounts WHERE id=$1', [gone]),
      ).toHaveLength(0);

      const [current] = await q(
        "SELECT payload->>'accountId' AS account_id FROM events WHERE session_id=$1 AND seq=2",
        [session],
      );
      const [revoked] = await q(
        "SELECT payload->>'accountId' AS account_id FROM events WHERE session_id=$1 AND seq=4",
        [session],
      );
      expect(current.account_id).not.toBe(gone);
      expect(revoked.account_id).toBe(current.account_id);
      expect(current.account_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(current.account_id).not.toBe(currentSeat);
      expect(current.account_id).not.toBe(revokedSeat);
      expect(
        await q('SELECT 1 FROM accounts WHERE id=$1', [current.account_id]),
      ).toHaveLength(0);

      expect(await loadSeatedMatureOptOuts(db, session)).toContain(true);
    } finally {
      await q('SELECT purge_session($1)', [session]);
      await q('DELETE FROM accounts WHERE id = ANY($1)', [[gone, heir]]);
    }
  });
});
