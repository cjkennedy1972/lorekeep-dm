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
  it('does not treat a co-player characterId as owned when shared payloads mention the deleted account', async () => {
    const gone = randomUUID();
    const coPlayer = randomUUID();
    const sharedSession = randomUUID();
    const coPlayerSession = randomUUID();
    const characterId = randomUUID();
    const seatId = randomUUID();
    await account(gone);
    await account(coPlayer);
    try {
      await q(
        'INSERT INTO account_characters(id,account_id,character) VALUES($1,$2,$3)',
        [characterId, coPlayer, { id: characterId, name: 'Co-player hero' }],
      );
      await q(
        'INSERT INTO sessions(id,owner_account_id,name,adventure_id) VALUES($1,$2,$3,$4)',
        [sharedSession, gone, 'Shared', 'adventure:01-hollow-under-marrowfell'],
      );
      await q(
        "INSERT INTO events(session_id,seq,turn_id,type,payload) VALUES($1,1,$2,'SeatJoined',$3)",
        [
          sharedSession,
          randomUUID(),
          {
            seatId: randomUUID(),
            accountId: coPlayer,
            displayName: 'Co-player',
          },
        ],
      );
      await q(
        "INSERT INTO events(session_id,seq,turn_id,type,payload) VALUES($1,2,$2,'ActionAccepted',$3)",
        [
          sharedSession,
          randomUUID(),
          { accountId: gone, characterId, text: 'A shared action' },
        ],
      );
      await q('INSERT INTO snapshots(session_id,seq,state) VALUES($1,1,$2)', [
        sharedSession,
        { accountId: gone, characterId },
      ]);
      await q(
        'INSERT INTO sessions(id,owner_account_id,name,adventure_id,character_id) VALUES($1,$2,$3,$4,$5)',
        [
          coPlayerSession,
          coPlayer,
          'Co-player session',
          'adventure:01-hollow-under-marrowfell',
          characterId,
        ],
      );
      await q(
        `INSERT INTO session_seat_characters
          (session_id,seat_id,account_id,character_id,character_revision,character_snapshot,binding_status)
         VALUES($1,$2,$3,$4,1,$5,'active')`,
        [
          coPlayerSession,
          seatId,
          coPlayer,
          characterId,
          { id: characterId, name: 'Co-player hero' },
        ],
      );
      await q(
        "INSERT INTO scene_summaries(session_id,scene_id,summary) VALUES($1,'keep-me','Co-player memory.')",
        [coPlayerSession],
      );
      await q(
        "UPDATE accounts SET status='deleting', deletion_requested_at=now() WHERE id=$1",
        [gone],
      );
      const result = await runSweep(db, {
        store: new LocalObjectStore(dir),
        log: () => {},
      });

      expect(result?.accounts.deleted).toBeGreaterThanOrEqual(1);
      expect(
        await q('SELECT id,account_id FROM account_characters WHERE id=$1', [
          characterId,
        ]),
      ).toEqual([{ id: characterId, account_id: coPlayer }]);
      expect(
        await q('SELECT character_id FROM sessions WHERE id=$1', [
          coPlayerSession,
        ]),
      ).toEqual([{ character_id: characterId }]);
      expect(
        await q(
          'SELECT character_id,binding_status FROM session_seat_characters WHERE session_id=$1 AND seat_id=$2',
          [coPlayerSession, seatId],
        ),
      ).toEqual([{ character_id: characterId, binding_status: 'active' }]);
      expect(
        await q('SELECT summary FROM scene_summaries WHERE session_id=$1', [
          coPlayerSession,
        ]),
      ).toEqual([{ summary: 'Co-player memory.' }]);
    } finally {
      await q('SELECT purge_session($1)', [sharedSession]);
      await q('SELECT purge_session($1)', [coPlayerSession]);
      await q('DELETE FROM accounts WHERE id = ANY($1)', [[gone, coPlayer]]);
    }
  }, 30_000);
  it('scrubs an owned unbound character referenced by a legacy bare characterId', async () => {
    const gone = randomUUID();
    const roomOwner = randomUUID();
    const session = randomUUID();
    const characterId = randomUUID();
    await account(gone);
    await account(roomOwner);
    try {
      await q(
        'INSERT INTO account_characters(id,account_id,character) VALUES($1,$2,$3)',
        [characterId, gone, { id: characterId, name: CHAR_NAME }],
      );
      await q(
        'INSERT INTO sessions(id,owner_account_id,name,adventure_id,character_id) VALUES($1,$2,$3,$4,$5)',
        [
          session,
          roomOwner,
          'Legacy reference',
          'adventure:01-hollow-under-marrowfell',
          characterId,
        ],
      );
      await q(
        "INSERT INTO events(session_id,seq,turn_id,type,payload) VALUES($1,1,$2,'LegacyAction',$3)",
        [
          session,
          randomUUID(),
          { accountId: gone, characterId, action: 'old event' },
        ],
      );
      await q(
        'INSERT INTO scene_summaries(session_id,scene_id,summary) VALUES($1,$2,$3)',
        [session, 'legacy-scene', 'Legacy character memory.'],
      );
      await q(
        "UPDATE accounts SET status='deleting', deletion_requested_at=now() WHERE id=$1",
        [gone],
      );
      const result = await runSweep(db, {
        store: new LocalObjectStore(dir),
        log: () => {},
      });
      expect(result?.accounts.deleted).toBeGreaterThanOrEqual(1);
      expect(
        await q('SELECT character_id FROM sessions WHERE id=$1', [session]),
      ).toEqual([{ character_id: null }]);
      expect(
        await q('SELECT 1 FROM scene_summaries WHERE session_id=$1', [session]),
      ).toHaveLength(0);
      expect(
        await q('SELECT 1 FROM account_characters WHERE id=$1', [characterId]),
      ).toHaveLength(0);
      expect(
        await q('SELECT payload FROM events WHERE session_id=$1', [session]),
      ).toEqual([
        {
          payload: expect.not.objectContaining({
            accountId: gone,
            characterId,
          }),
        },
      ]);
    } finally {
      await q('SELECT purge_session($1)', [session]);
      await q('DELETE FROM accounts WHERE id = ANY($1)', [[gone, roomOwner]]);
    }
  }, 30_000);

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
  }, 30_000);

  it('removes derived rows from sessions referencing a deleted released character', async () => {
    const owner = randomUUID();
    const session = randomUUID();
    const otherSession = randomUUID();
    const otherOwner = randomUUID();
    const characterId = randomUUID();
    const seatId = randomUUID();
    await account(owner);
    await account(otherOwner);
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
      await q(
        'INSERT INTO sessions(id,owner_account_id,name,adventure_id) VALUES($1,$2,$3,$4)',
        [
          otherSession,
          otherOwner,
          'Unrelated session',
          'adventure:01-hollow-under-marrowfell',
        ],
      );
      await q(
        'INSERT INTO scene_summaries(session_id,scene_id,summary) VALUES($1,$2,$3)',
        [otherSession, 'unrelated-scene', 'Other account memory remains.'],
      );
      await q(
        `INSERT INTO session_lease(session_id,node_id,expires_at,epoch)
         VALUES($1,'old-room',now() - interval '1 second',7)`,
        [session],
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
      expect(
        await q(
          'SELECT node_id,epoch,expires_at <= clock_timestamp() AS expired FROM session_lease WHERE session_id=$1',
          [session],
        ),
      ).toEqual([{ node_id: '', epoch: '8', expired: true }]);
      expect(
        await q('SELECT summary FROM scene_summaries WHERE session_id=$1', [
          otherSession,
        ]),
      ).toEqual([{ summary: 'Other account memory remains.' }]);
    } finally {
      await q('SELECT purge_session($1)', [session]);
      await q('SELECT purge_session($1)', [otherSession]);
      await q('DELETE FROM accounts WHERE id = ANY($1)', [[owner, otherOwner]]);
    }
  });

  it('skips a legal-held session when deleting a reusable character', async () => {
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
          'Held character session',
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
        [session, 'held-character-scene', 'Held memory stays.'],
      );
      await q("INSERT INTO legal_holds(kind,item_id) VALUES('session',$1)", [
        session,
      ]);
      let failure: unknown;
      try {
        await new SeatCharacterRepository(db).deleteOwnedCharacter(
          owner,
          characterId,
        );
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ code: 'SESSION_HELD' });
      expect(
        await q('SELECT id FROM account_characters WHERE id=$1', [characterId]),
      ).toHaveLength(1);
      expect(
        await q('SELECT summary FROM scene_summaries WHERE session_id=$1', [
          session,
        ]),
      ).toEqual([{ summary: 'Held memory stays.' }]);
      expect(
        await q('SELECT node_id FROM session_lease WHERE session_id=$1', [
          session,
        ]),
      ).toHaveLength(0);
    } finally {
      await q('DELETE FROM legal_holds WHERE item_id=$1', [session]);
      await q('SELECT purge_session($1)', [session]);
      await q('DELETE FROM accounts WHERE id=$1', [owner]);
    }
  });

  it('skips a legal-held character-referenced session before scrubbing account deletion', async () => {
    const gone = randomUUID();
    const heir = randomUUID();
    const otherOwner = randomUUID();
    const ownedSession = randomUUID();
    const heldSession = randomUUID();
    const characterId = `char_${randomUUID().slice(0, 8)}`;
    await account(gone);
    await account(heir);
    await account(otherOwner);
    try {
      await q(
        'INSERT INTO sessions(id,owner_account_id,name,adventure_id,character_id) VALUES($1,$2,$3,$4,$5),($6,$7,$8,$4,$5)',
        [
          ownedSession,
          gone,
          'Owned',
          'adventure:01-hollow-under-marrowfell',
          characterId,
          heldSession,
          otherOwner,
          'Character reference',
        ],
      );
      await q(
        `INSERT INTO events(session_id,seq,turn_id,type,payload)
         VALUES($1,1,$2,'SeatJoined',$3),($1,2,$2,'SeatJoined',$4)`,
        [
          ownedSession,
          randomUUID(),
          { seatId: randomUUID(), accountId: gone, displayName: 'Gone' },
          { seatId: randomUUID(), accountId: heir, displayName: 'Heir' },
        ],
      );
      await q(
        'INSERT INTO scene_summaries(session_id,scene_id,summary) VALUES($1,$2,$3)',
        [heldSession, 'held-scene', 'Retain while held.'],
      );
      await q("INSERT INTO legal_holds(kind,item_id) VALUES('session',$1)", [
        heldSession,
      ]);
      await q(
        "UPDATE accounts SET status='deleting', deletion_requested_at=now() WHERE id=$1",
        [gone],
      );
      const result = await runSweep(db, {
        store: new LocalObjectStore(dir),
        log: () => {},
      });
      expect(
        (result?.accounts.held ?? 0) + (result?.accounts.failed ?? 0),
      ).toBeGreaterThanOrEqual(1);
      expect(
        await q('SELECT status FROM accounts WHERE id=$1', [gone]),
      ).toEqual([{ status: 'deleting' }]);
      expect(
        await q('SELECT summary FROM scene_summaries WHERE session_id=$1', [
          heldSession,
        ]),
      ).toEqual([{ summary: 'Retain while held.' }]);
      expect(
        await q('SELECT node_id FROM session_lease WHERE session_id=$1', [
          heldSession,
        ]),
      ).toHaveLength(0);
    } finally {
      await q('DELETE FROM legal_holds WHERE item_id=$1', [heldSession]);
      await q('SELECT purge_session($1)', [ownedSession]);
      await q('SELECT purge_session($1)', [heldSession]);
      await q('DELETE FROM accounts WHERE id = ANY($1)', [
        [gone, heir, otherOwner],
      ]);
    }
  }, 90_000);
});
