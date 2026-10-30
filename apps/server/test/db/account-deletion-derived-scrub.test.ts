import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RegistryMemory } from '../../src/dm/memory.js';
import { SeatCharacterRepository } from '../../src/persistence/seatCharacters.js';
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

describe('account deletion scrubs DM-authored derived memory', () => {
  it('removes derived rows that may contain the deleted character name or quoted player text', async () => {
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
        await q('SELECT 1 FROM scene_summaries WHERE session_id=$1', [session]),
      ).toHaveLength(0);
      expect(
        await q('SELECT 1 FROM registry_entries WHERE session_id=$1', [
          session,
        ]),
      ).toHaveLength(0);
      expect(
        await q(
          'SELECT 1 FROM registry_facts f JOIN registry_entries e ON e.id=f.entry_id WHERE e.session_id=$1',
          [session],
        ),
      ).toHaveLength(0);
    } finally {
      await q('SELECT purge_session($1)', [session]);
      await q('DELETE FROM accounts WHERE id = ANY($1)', [[gone, heir]]);
    }
  });

  it('removes derived rows from sessions referencing a deleted released character', async () => {
    const owner = randomUUID();
    const session = randomUUID();
    const characterId = randomUUID();
    const seatId = randomUUID();
    await account(owner);
    try {
      await q(
        'INSERT INTO account_characters(id,account_id,character) VALUES($1,$2,$3)',
        [characterId, owner, { id: characterId, name: CHAR_NAME }],
      );
      await q(
        'INSERT INTO sessions(id,owner_account_id,name,adventure_id) VALUES($1,$2,$3,$4)',
        [
          session,
          owner,
          'Character scrub',
          'adventure:01-hollow-under-marrowfell',
        ],
      );
      await q(
        `INSERT INTO session_seat_characters
          (session_id,seat_id,account_id,character_id,character_revision,character_snapshot,binding_status,unbound_at)
         VALUES($1,$2,$3,$4,1,$5,'released',now())`,
        [
          session,
          seatId,
          owner,
          characterId,
          { id: characterId, name: CHAR_NAME },
        ],
      );
      await q(
        'INSERT INTO scene_summaries(session_id,scene_id,summary) VALUES($1,$2,$3)',
        [session, 'scene-quoted', `The player said: “I am ${CHAR_NAME}.”`],
      );
      const entry = await q(
        `INSERT INTO registry_entries(session_id,entity_type,entity_id,version,name,payload,search_document)
         VALUES($1,'npc','npc_guard',1,'Guard Captain',$2,$3) RETURNING id`,
        [session, { role: `${CHAR_NAME} said yes` }, `${CHAR_NAME} said yes`],
      );
      await q('INSERT INTO registry_facts(entry_id,fact) VALUES($1,$2)', [
        entry[0].id,
        `${CHAR_NAME} said yes to the guard`,
      ]);

      expect(
        await new SeatCharacterRepository(db).deleteOwnedCharacter(
          owner,
          characterId,
        ),
      ).toBe(true);
      expect(
        await q('SELECT 1 FROM scene_summaries WHERE session_id=$1', [session]),
      ).toHaveLength(0);
      expect(
        await q('SELECT 1 FROM registry_entries WHERE session_id=$1', [
          session,
        ]),
      ).toHaveLength(0);
      expect(
        await q('SELECT 1 FROM account_characters WHERE id=$1', [characterId]),
      ).toHaveLength(0);
    } finally {
      await q('SELECT purge_session($1)', [session]);
      await q('DELETE FROM accounts WHERE id=$1', [owner]);
    }
  });
});
