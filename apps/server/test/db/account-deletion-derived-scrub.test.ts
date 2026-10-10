import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RegistryMemory } from '../../src/dm/memory.js';
import { LocalObjectStore } from '../../src/storage/objectStore.js';
import { runSweep } from '../../src/retention/sweeper.js';

const CHAR_NAME = 'Brann';
const SUMMARY =
  'The guard answered yes. Brannigan waits by the well. Brann the bold nods.';
const FACT_160 = `Brann ${'x'.repeat(154)}`;
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
  dir = await mkdtemp(join(tmpdir(), 'derived-scrub-'));
});
afterAll(async () => {
  await db.end();
  await rm(dir, { recursive: true, force: true });
});

describe('account deletion leaves DM-authored derived memory unscrubbed (ADR-017 known limit)', () => {
  it('completes deletion with derived rows still naming the character, including facts differing only by case', async () => {
    const gone = randomUUID();
    const heir = randomUUID();
    const session = randomUUID();
    const charId = `char_${randomUUID().slice(0, 8)}`;
    await account(gone);
    await account(heir);
    try {
      await q(
        'INSERT INTO sessions(id,owner_account_id,name,adventure_id,character_id) VALUES($1,$2,$3,$4,$5)',
        [
          session,
          gone,
          'Derived',
          'adventure:01-hollow-under-marrowfell',
          charId,
        ],
      );
      await q(
        "INSERT INTO events(session_id,seq,turn_id,type,payload) VALUES($1,1,$2,'SeatJoined',$3),($1,2,$2,'SeatJoined',$4),($1,3,$5,'ActionAccepted',$6)",
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
            seatId: randomUUID(),
            accountId: gone,
            displayName: 'Acct',
            presence: 'offline',
          },
          randomUUID(),
          { accountId: gone, actionId: 'a1', text: 'yes', playerName: 'Brann' },
        ],
      );
      await q('INSERT INTO snapshots(session_id,seq,state) VALUES($1,3,$2)', [
        session,
        {
          lastPlayerText: 'yes',
          party: { [gone]: { id: charId, name: CHAR_NAME } },
        },
      ]);
      await q(
        "INSERT INTO scene_summaries(session_id,scene_id,summary) VALUES($1,'scene-well',$2)",
        [session, SUMMARY],
      );
      await new RegistryMemory(db).upsert(session, {
        kind: 'npc',
        id: 'npc_guard',
        after: {
          id: 'npc_guard',
          name: 'Guard Captain',
          role: 'Brann pays in gold',
          disposition: 'neutral',
          facts: [
            'Brann said yes to the guard',
            FACT_160,
            'Brann is brave.',
            'brann is brave.',
          ],
        },
      });

      await q(
        "UPDATE accounts SET status='deleting', deletion_requested_at=now() WHERE id=$1",
        [gone],
      );
      const result = await runSweep(db, {
        store: new LocalObjectStore(dir),
        log: () => {},
      });

      expect(result?.accounts.deleted).toBeGreaterThanOrEqual(1);
      expect(result?.accounts.failed).toBe(0);
      expect(
        await q('SELECT 1 FROM accounts WHERE id=$1', [gone]),
      ).toHaveLength(0);
      expect(
        await q('SELECT owner_account_id FROM sessions WHERE id=$1', [session]),
      ).toEqual([{ owner_account_id: heir }]);

      expect(
        await q('SELECT summary FROM scene_summaries WHERE session_id=$1', [
          session,
        ]),
      ).toEqual([{ summary: SUMMARY }]);
      const [entry] = await q(
        "SELECT payload->>'role' AS role, payload::text AS payload, search_document FROM registry_entries WHERE session_id=$1",
        [session],
      );
      expect(entry.role).toBe('Brann pays in gold');
      expect(entry.search_document).toContain('Brann pays in gold');
      expect(
        await q(
          'SELECT fact, length(fact) AS len FROM registry_facts f JOIN registry_entries e ON e.id=f.entry_id WHERE e.session_id=$1 ORDER BY f.id',
          [session],
        ),
      ).toEqual([
        { fact: 'Brann said yes to the guard', len: 27 },
        { fact: FACT_160, len: 160 },
        { fact: 'Brann is brave.', len: 15 },
        { fact: 'brann is brave.', len: 15 },
      ]);
    } finally {
      await q('SELECT purge_session($1)', [session]);
      await q('DELETE FROM accounts WHERE id = ANY($1)', [[gone, heir]]);
    }
  });
});
