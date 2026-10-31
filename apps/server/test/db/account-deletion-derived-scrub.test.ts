import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SeatCharacterRepository } from '../../src/persistence/seatCharacters.js';
import { LocalObjectStore } from '../../src/storage/objectStore.js';
import { runSweep } from '../../src/retention/sweeper.js';

const CHAR_NAME = 'Brann';
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
  await db.query(
    'UPDATE derived_memory_reconciliation_state SET complete=true WHERE singleton=true',
  );
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
      const token = 'R'.repeat(32);
      const summary = await q(
        'INSERT INTO scene_summaries(session_id,scene_id,summary) VALUES($1,$2,$3) RETURNING id',
        [session, 'legacy-scene', `Legacy character memory ${token}.`],
      );
      const entry = await q(
        `INSERT INTO registry_entries(session_id,entity_type,entity_id,version,name,payload,search_document)
         VALUES($1,'npc','legacy-npc',1,'Legacy NPC',$2,$3) RETURNING id`,
        [
          session,
          { note: `Legacy character reference ${token}.` },
          `Legacy character reference ${token}`,
        ],
      );
      await q(
        'INSERT INTO session_character_tokens(session_id,character_id,token) VALUES($1,$2,$3)',
        [session, characterId, token],
      );
      await q(
        `INSERT INTO derived_memory_character_refs(session_id,character_id,row_kind,row_id) VALUES
        ($1,$2,'scene_summary',$3),($1,$2,'registry_entry',$4)`,
        [session, characterId, summary[0].id, entry[0].id],
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
      expect(
        await q('SELECT 1 FROM account_characters WHERE id=$1', [characterId]),
      ).toHaveLength(0);
      expect(
        await q(
          'SELECT 1 FROM session_character_tokens WHERE session_id=$1 AND character_id=$2',
          [session, characterId],
        ),
      ).toHaveLength(0);
      expect(
        await q(
          'SELECT 1 FROM derived_memory_character_refs WHERE session_id=$1 AND character_id=$2',
          [session, characterId],
        ),
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

  it('deletes only indexed account-character rows in a shared room', async () => {
    const gone = randomUUID();
    const heir = randomUUID();
    const session = randomUUID();
    const charId = randomUUID();
    const heirCharId = randomUUID();
    const targetToken = 'T'.repeat(32);
    const heirToken = 'A'.repeat(32);
    await account(gone);
    await account(heir);
    try {
      await q(
        'INSERT INTO account_characters(id,account_id,character) VALUES($1,$2,$3),($4,$5,$6)',
        [
          charId,
          gone,
          { id: charId, name: CHAR_NAME },
          heirCharId,
          heir,
          { id: heirCharId, name: 'Heir' },
        ],
      );
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
        `INSERT INTO session_seat_characters
          (session_id,seat_id,account_id,character_id,character_revision,character_snapshot,binding_status)
         VALUES($1,$2,$3,$4,1,$5,'active'),($1,$6,$7,$8,1,$9,'active')`,
        [
          session,
          randomUUID(),
          gone,
          charId,
          { id: charId, name: CHAR_NAME },
          randomUUID(),
          heir,
          heirCharId,
          { id: heirCharId, name: 'Heir' },
        ],
      );
      await q(
        "INSERT INTO events(session_id,seq,turn_id,type,payload) VALUES($1,1,$2,'SeatJoined',$3),($1,2,$2,'SeatJoined',$4),($1,3,$5,'ActionAccepted',$6)",
        [
          session,
          randomUUID(),
          { seatId: randomUUID(), accountId: heir, displayName: 'Heir' },
          { seatId: randomUUID(), accountId: gone, displayName: 'Acct' },
          randomUUID(),
          { accountId: gone, actionId: 'a1', text: 'yes', playerName: 'Brann' },
        ],
      );
      await q(
        'INSERT INTO session_character_tokens(session_id,character_id,token) VALUES($1,$2,$3),($1,$4,$5)',
        [session, charId, targetToken, heirCharId, heirToken],
      );
      const targetSummary = await q(
        'INSERT INTO scene_summaries(session_id,scene_id,summary) VALUES($1,$2,$3) RETURNING id',
        [session, 'target-scene', `Brann said yes. ${targetToken}`],
      );
      const heirSummary = await q(
        'INSERT INTO scene_summaries(session_id,scene_id,summary) VALUES($1,$2,$3) RETURNING id',
        [session, 'heir-scene', `Heir waits. ${heirToken}`],
      );
      const targetEntry = await q(
        `INSERT INTO registry_entries(session_id,entity_type,entity_id,version,name,payload,search_document)
         VALUES($1,'npc','target-guard',1,'Guard',$2,$3) RETURNING id`,
        [
          session,
          { note: `Brann repeated “yes”. ${targetToken}` },
          `Brann ${targetToken}`,
        ],
      );
      const npcEntry = await q(
        `INSERT INTO registry_entries(session_id,entity_type,entity_id,version,name,payload,search_document)
         VALUES($1,'npc','npc-mira',1,'Mira',$2,'Mira sells maps') RETURNING id`,
        [session, { role: 'map seller' }],
      );
      await q(
        'INSERT INTO registry_facts(entry_id,fact) VALUES($1,$2),($3,$4)',
        [
          targetEntry[0].id,
          `Brann ${targetToken} repeated yes`,
          npcEntry[0].id,
          'Mira sells maps by the river',
        ],
      );
      await q(
        `INSERT INTO derived_memory_character_refs(session_id,character_id,row_kind,row_id) VALUES
         ($1,$2,'scene_summary',$3),($1,$4,'scene_summary',$5),($1,$2,'registry_entry',$6)`,
        [
          session,
          charId,
          targetSummary[0].id,
          heirCharId,
          heirSummary[0].id,
          targetEntry[0].id,
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
      expect(result?.accounts.deleted).toBeGreaterThanOrEqual(1);
      expect(
        await q('SELECT 1 FROM accounts WHERE id=$1', [gone]),
      ).toHaveLength(0);
      expect(
        await q('SELECT owner_account_id FROM sessions WHERE id=$1', [session]),
      ).toEqual([{ owner_account_id: heir }]);
      expect(
        await q('SELECT 1 FROM scene_summaries WHERE id=$1', [
          targetSummary[0].id,
        ]),
      ).toHaveLength(0);
      expect(
        await q('SELECT 1 FROM registry_entries WHERE id=$1', [
          targetEntry[0].id,
        ]),
      ).toHaveLength(0);
      expect(
        await q('SELECT 1 FROM registry_facts WHERE entry_id=$1', [
          targetEntry[0].id,
        ]),
      ).toHaveLength(0);
      expect(
        await q(
          'SELECT 1 FROM session_character_tokens WHERE session_id=$1 AND character_id=$2',
          [session, charId],
        ),
      ).toHaveLength(0);
      expect(
        await q('SELECT id FROM scene_summaries WHERE session_id=$1', [
          session,
        ]),
      ).toEqual([{ id: heirSummary[0].id }]);
      expect(
        await q('SELECT id FROM registry_entries WHERE session_id=$1', [
          session,
        ]),
      ).toEqual([{ id: npcEntry[0].id }]);
      expect(
        await q('SELECT 1 FROM registry_facts WHERE entry_id=$1', [
          npcEntry[0].id,
        ]),
      ).toHaveLength(1);
      expect(
        await q(
          'SELECT token FROM session_character_tokens WHERE session_id=$1 AND character_id=$2',
          [session, heirCharId],
        ),
      ).toEqual([{ token: heirToken }]);
    } finally {
      await q('SELECT purge_session($1)', [session]);
      await q('DELETE FROM accounts WHERE id = ANY($1)', [[gone, heir]]);
    }
  }, 30_000);

  it('deletes only indexed derived rows for a deleted released character', async () => {
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
      const token = 'D'.repeat(32);
      const summary = await q(
        'INSERT INTO scene_summaries(session_id,scene_id,summary) VALUES($1,$2,$3) RETURNING id',
        [
          session,
          'scene-quoted',
          `The player said: “I am ${CHAR_NAME}.” ${token}`,
        ],
      );
      await q(
        'INSERT INTO scene_summaries(session_id,scene_id,summary) VALUES($1,$2,$3)',
        [session, 'unrelated-scene', 'Unrelated memory survives.'],
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
        [
          session,
          { role: `${CHAR_NAME} said yes ${token}` },
          `${CHAR_NAME} said yes ${token}`,
        ],
      );
      await q('INSERT INTO registry_facts(entry_id,fact) VALUES($1,$2)', [
        entry[0].id,
        `${CHAR_NAME} said yes to the guard`,
      ]);
      const unrelatedEntry = await q(
        `INSERT INTO registry_entries(session_id,entity_type,entity_id,version,name,payload,search_document)
         VALUES($1,'npc','npc_unrelated',1,'Mira',$2,'Mira trades maps') RETURNING id`,
        [session, { role: 'A cartographer' }],
      );
      await q('INSERT INTO registry_facts(entry_id,fact) VALUES($1,$2)', [
        unrelatedEntry[0].id,
        'Mira trades maps at the river market',
      ]);
      await q(
        'INSERT INTO session_character_tokens(session_id,character_id,token) VALUES($1,$2,$3)',
        [session, characterId, token],
      );
      await q(
        `INSERT INTO derived_memory_character_refs(session_id,character_id,row_kind,row_id) VALUES
        ($1,$2,'scene_summary',$3),($1,$2,'registry_entry',$4)`,
        [session, characterId, summary[0].id, entry[0].id],
      );

      expect(
        await new SeatCharacterRepository(db).deleteOwnedCharacter(
          owner,
          characterId,
        ),
      ).toBe(true);
      expect(
        await q(
          'SELECT scene_id,summary FROM scene_summaries WHERE session_id=$1',
          [session],
        ),
      ).toEqual([
        { scene_id: 'unrelated-scene', summary: 'Unrelated memory survives.' },
      ]);
      expect(
        await q(
          'SELECT entity_id,name,payload,search_document FROM registry_entries WHERE session_id=$1',
          [session],
        ),
      ).toEqual([
        {
          entity_id: 'npc_unrelated',
          name: 'Mira',
          payload: { role: 'A cartographer' },
          search_document: 'Mira trades maps',
        },
      ]);
      expect(
        await q('SELECT fact FROM registry_facts WHERE entry_id=$1', [
          unrelatedEntry[0].id,
        ]),
      ).toEqual([{ fact: 'Mira trades maps at the river market' }]);
      expect(
        await new SeatCharacterRepository(db).deleteOwnedCharacter(
          owner,
          characterId,
        ),
      ).toBe(false);
      expect(
        await q('SELECT 1 FROM registry_facts WHERE entry_id=$1', [
          entry[0].id,
        ]),
      ).toHaveLength(0);
      expect(
        await q('SELECT 1 FROM account_characters WHERE id=$1', [characterId]),
      ).toHaveLength(0);
      expect(
        await q(
          'SELECT 1 FROM session_character_tokens WHERE session_id=$1 AND character_id=$2',
          [session, characterId],
        ),
      ).toHaveLength(0);
      expect(
        await q(
          'SELECT 1 FROM derived_memory_character_refs WHERE session_id=$1 AND character_id=$2',
          [session, characterId],
        ),
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

  it('redacts unheld account character tokens and deletes their indexed token-bearing rows', async () => {
    await q(
      'UPDATE derived_memory_reconciliation_state SET complete=true WHERE singleton=true',
    );
    const owner = randomUUID();
    const session = randomUUID();
    const characterId = randomUUID();
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
          'Redaction test',
          'adventure:01-hollow-under-marrowfell',
        ],
      );
      const token = 'T'.repeat(32);
      const summary = await q(
        'INSERT INTO scene_summaries(session_id,scene_id,summary) VALUES($1,$2,$3) RETURNING id',
        [session, 'redaction-memory', `Stored token ${token}`],
      );
      await q(
        'INSERT INTO session_character_tokens(session_id,character_id,token) VALUES($1,$2,$3)',
        [session, characterId, token],
      );
      await q(
        `INSERT INTO derived_memory_character_refs(session_id,character_id,row_kind,row_id) VALUES($1,$2,'scene_summary',$3)`,
        [session, characterId, summary[0].id],
      );
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        await SeatCharacterRepository.redactAccount(client, owner);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
      expect(
        await q('SELECT id FROM scene_summaries WHERE session_id=$1', [
          session,
        ]),
      ).toHaveLength(0);
      expect(
        await q('SELECT 1 FROM session_character_tokens WHERE session_id=$1', [
          session,
        ]),
      ).toHaveLength(0);
      expect(
        await q(
          'SELECT 1 FROM derived_memory_character_refs WHERE session_id=$1',
          [session],
        ),
      ).toHaveLength(0);
    } finally {
      await q('SELECT purge_session($1)', [session]);
      await q('DELETE FROM accounts WHERE id=$1', [owner]);
    }
  });

  it('retains mappings and unindexed token prose when reconciliation is incomplete', async () => {
    const owner = randomUUID();
    const roomOwner = randomUUID();
    const session = randomUUID();
    const characterId = randomUUID();
    const token = 'U'.repeat(32);
    const prior = await q(
      'SELECT complete FROM derived_memory_reconciliation_state WHERE singleton=true',
    );
    await account(owner);
    await account(roomOwner);
    try {
      await q(
        'UPDATE derived_memory_reconciliation_state SET complete=false WHERE singleton=true',
      );
      await q(
        'INSERT INTO account_characters(id,account_id,character) VALUES($1,$2,$3)',
        [characterId, owner, { id: characterId, name: CHAR_NAME }],
      );
      await q(
        'INSERT INTO sessions(id,owner_account_id,name,adventure_id) VALUES($1,$2,$3,$4)',
        [
          session,
          roomOwner,
          'Unverified coverage',
          'adventure:01-hollow-under-marrowfell',
        ],
      );
      const coCharacterId = randomUUID();
      await q(
        'INSERT INTO account_characters(id,account_id,character) VALUES($1,$2,$3)',
        [coCharacterId, roomOwner, { id: coCharacterId, name: 'Co-player' }],
      );
      await q(
        `INSERT INTO session_seat_characters
          (session_id,seat_id,account_id,character_id,character_revision,character_snapshot,binding_status)
         VALUES($1,$2,$3,$4,1,$5,'active')`,
        [
          session,
          randomUUID(),
          roomOwner,
          coCharacterId,
          { id: coCharacterId, name: 'Co-player' },
        ],
      );
      await q(
        'INSERT INTO session_character_tokens(session_id,character_id,token) VALUES($1,$2,$3)',
        [session, characterId, token],
      );
      await q(
        'INSERT INTO scene_summaries(session_id,scene_id,summary) VALUES($1,$2,$3)',
        [session, 'unindexed', `Unindexed prose ${token}`],
      );
      await q(
        "UPDATE accounts SET status='deleting', deletion_requested_at=now() WHERE id=$1",
        [owner],
      );
      const result = await runSweep(db, {
        store: new LocalObjectStore(dir),
        log: () => {},
        reconciliationBatchSize: 1,
        reconciliationTimeBudgetMs: 1,
        monotonicNowMs: (() => {
          let call = 0;
          return () => (call++ === 0 ? 0 : 10);
        })(),
      });
      const mappingRowsLeft = await q(
        'SELECT count(*)::int AS count FROM session_character_tokens WHERE session_id=$1 AND character_id=$2',
        [session, characterId],
      );
      expect(mappingRowsLeft[0].count).toBeGreaterThan(0);
      expect(
        await q('SELECT summary FROM scene_summaries WHERE session_id=$1', [
          session,
        ]),
      ).toEqual([{ summary: `Unindexed prose ${token}` }]);
      expect(result?.accounts.held).toBeGreaterThan(0);
      expect(
        await q('SELECT status FROM accounts WHERE id=$1', [owner]),
      ).toEqual([{ status: 'deleting' }]);
    } finally {
      await q(
        'UPDATE derived_memory_reconciliation_state SET complete=$1 WHERE singleton=true',
        [prior[0]?.complete ?? false],
      );
      await q('SELECT purge_session($1)', [session]);
      await q('DELETE FROM accounts WHERE id = ANY($1)', [[owner, roomOwner]]);
    }
  });

  it('defers unverified solo-session cleanup without deleting released-player or NPC rows', async () => {
    const owner = randomUUID();
    const coOwner = randomUUID();
    const roomOwner = randomUUID();
    const session = randomUUID();
    const characterId = randomUUID();
    const releasedCharacterId = randomUUID();
    const targetToken = 'W'.repeat(32);
    const releasedToken = 'X'.repeat(32);
    const prior = await q(
      'SELECT complete FROM derived_memory_reconciliation_state WHERE singleton=true',
    );
    await account(owner);
    await account(coOwner);
    await account(roomOwner);
    try {
      await q(
        'UPDATE derived_memory_reconciliation_state SET complete=false WHERE singleton=true',
      );
      await q(
        'INSERT INTO account_characters(id,account_id,character) VALUES($1,$2,$3)',
        [characterId, owner, { id: characterId, name: CHAR_NAME }],
      );
      await q(
        'INSERT INTO account_characters(id,account_id,character) VALUES($1,$2,$3)',
        [
          releasedCharacterId,
          coOwner,
          { id: releasedCharacterId, name: 'Released Co-player' },
        ],
      );
      await q(
        'INSERT INTO sessions(id,owner_account_id,name,adventure_id) VALUES($1,$2,$3,$4)',
        [
          session,
          roomOwner,
          'Unverified solo fallback',
          'adventure:01-hollow-under-marrowfell',
        ],
      );
      await q(
        `INSERT INTO session_seat_characters(session_id,seat_id,account_id,character_id,character_revision,character_snapshot,binding_status)
        VALUES($1,$2,$3,$4,1,$5,'released')`,
        [
          session,
          randomUUID(),
          coOwner,
          releasedCharacterId,
          { id: releasedCharacterId, name: 'Released Co-player' },
        ],
      );
      await q(
        'INSERT INTO session_character_tokens(session_id,character_id,token) VALUES($1,$2,$3),($1,$4,$5)',
        [session, characterId, targetToken, releasedCharacterId, releasedToken],
      );
      await q(
        "INSERT INTO events(session_id,seq,turn_id,type,payload) VALUES($1,1,$1,'SeatJoined',$2)",
        [
          session,
          {
            seatId: randomUUID(),
            accountId: coOwner,
            displayName: 'Released Co-player',
          },
        ],
      );
      const summary = await q(
        'INSERT INTO scene_summaries(session_id,scene_id,summary) VALUES($1,$2,$3) RETURNING id',
        [session, 'released-co-player', `Released text ${releasedToken}`],
      );
      await q(
        `INSERT INTO derived_memory_character_refs(session_id,character_id,row_kind,row_id) VALUES($1,$2,'scene_summary',$3)`,
        [session, releasedCharacterId, summary[0].id],
      );
      const npc = await q(
        `INSERT INTO registry_entries(session_id,entity_type,entity_id,version,name,payload,search_document) VALUES($1,'npc','npc-safe',1,'Town Guard',$2,'Town Guard protects the gate') RETURNING id`,
        [session, { description: 'NPC-only fact' }],
      );
      await q(
        "UPDATE accounts SET status='deleting', deletion_requested_at=now() WHERE id=$1",
        [owner],
      );
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        await expect(
          SeatCharacterRepository.redactAccount(client, owner),
        ).rejects.toThrow(/coverage|held/i);
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
      expect(
        await q(
          'SELECT token FROM session_character_tokens WHERE session_id=$1 ORDER BY token',
          [session],
        ),
      ).toEqual(
        [{ token: targetToken }, { token: releasedToken }].sort((a, b) =>
          a.token.localeCompare(b.token),
        ),
      );
      expect(
        await q('SELECT id FROM scene_summaries WHERE id=$1', [summary[0].id]),
      ).toHaveLength(1);
      expect(
        await q('SELECT id FROM registry_entries WHERE id=$1', [npc[0].id]),
      ).toHaveLength(1);
      expect(
        await q('SELECT status FROM accounts WHERE id=$1', [owner]),
      ).toEqual([{ status: 'deleting' }]);
      expect(
        await q(
          "SELECT payload->>'accountId' AS account_id FROM events WHERE session_id=$1 AND type='SeatJoined'",
          [session],
        ),
      ).toEqual([{ account_id: coOwner }]);
    } finally {
      await q(
        'UPDATE derived_memory_reconciliation_state SET complete=$1 WHERE singleton=true',
        [prior[0]?.complete ?? false],
      );
      await q('SELECT purge_session($1)', [session]);
      await q('DELETE FROM accounts WHERE id=ANY($1)', [
        [owner, coOwner, roomOwner],
      ]);
    }
  });

  it('deletes only referenced rows in a proven-solo session and preserves unreferenced NPC memory', async () => {
    const owner = randomUUID();
    const session = randomUUID();
    const characterId = randomUUID();
    const token = 'Y'.repeat(32);
    await account(owner);
    try {
      await q(
        'UPDATE derived_memory_reconciliation_state SET complete=true WHERE singleton=true',
      );
      await q(
        'INSERT INTO account_characters(id,account_id,character) VALUES($1,$2,$3)',
        [characterId, owner, { id: characterId, name: CHAR_NAME }],
      );
      await q(
        'INSERT INTO sessions(id,owner_account_id,name,adventure_id) VALUES($1,$2,$3,$4)',
        [
          session,
          owner,
          'Solo indexed session',
          'adventure:01-hollow-under-marrowfell',
        ],
      );
      await q(
        'INSERT INTO session_character_tokens(session_id,character_id,token) VALUES($1,$2,$3)',
        [session, characterId, token],
      );
      const summary = await q(
        'INSERT INTO scene_summaries(session_id,scene_id,summary) VALUES($1,$2,$3) RETURNING id',
        [session, 'targeted-summary', `Target ${token}`],
      );
      await q(
        `INSERT INTO derived_memory_character_refs(session_id,character_id,row_kind,row_id) VALUES($1,$2,'scene_summary',$3)`,
        [session, characterId, summary[0].id],
      );
      const npc = await q(
        `INSERT INTO registry_entries(session_id,entity_type,entity_id,version,name,payload,search_document) VALUES($1,'npc','npc_survives',1,'Town Guard',$2,'Town Guard protects the gate') RETURNING id`,
        [session, { role: 'guard', facts: ['Keeps watch'] }],
      );
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        await SeatCharacterRepository.redactAccount(client, owner);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
      expect(
        await q('SELECT id FROM scene_summaries WHERE id=$1', [summary[0].id]),
      ).toHaveLength(0);
      expect(
        await q(
          'SELECT token FROM session_character_tokens WHERE session_id=$1',
          [session],
        ),
      ).toHaveLength(0);
      expect(
        await q('SELECT id FROM registry_entries WHERE id=$1', [npc[0].id]),
      ).toHaveLength(1);
    } finally {
      await q('SELECT purge_session($1)', [session]);
      await q('DELETE FROM accounts WHERE id=$1', [owner]);
    }
  });

  it('deletes only indexed registry versions in a shared session', async () => {
    const owner = randomUUID();
    const roomOwner = randomUUID();
    const session = randomUUID();
    const characterId = randomUUID();
    const token = 'V'.repeat(32);
    const prior = await q(
      'SELECT complete FROM derived_memory_reconciliation_state WHERE singleton=true',
    );
    await account(owner);
    await account(roomOwner);
    try {
      await q(
        'UPDATE derived_memory_reconciliation_state SET complete=true WHERE singleton=true',
      );
      await q(
        'INSERT INTO account_characters(id,account_id,character) VALUES($1,$2,$3)',
        [characterId, owner, { id: characterId, name: CHAR_NAME }],
      );
      await q(
        'INSERT INTO sessions(id,owner_account_id,name,adventure_id) VALUES($1,$2,$3,$4)',
        [
          session,
          roomOwner,
          'Registry chain',
          'adventure:01-hollow-under-marrowfell',
        ],
      );
      const first = await q(
        `INSERT INTO registry_entries(session_id,entity_type,entity_id,version,name,payload,search_document) VALUES($1,'npc','chain-npc',1,'Guard',$2,$3) RETURNING id`,
        [session, { note: token }, token],
      );
      const successor = await q(
        `INSERT INTO registry_entries(session_id,entity_type,entity_id,version,name,payload,search_document,supersedes_id) VALUES($1,'npc','chain-npc',2,'Guard',$2,'successor',$3) RETURNING id`,
        [session, { note: 'successor' }, first[0].id],
      );
      const unrelated = await q(
        `INSERT INTO registry_entries(session_id,entity_type,entity_id,version,name,payload,search_document) VALUES($1,'npc','unrelated-npc',1,'Mira',$2,'Mira is a friendly merchant') RETURNING id`,
        [session, { description: 'A friendly merchant' }],
      );
      await q('INSERT INTO registry_facts(entry_id,fact) VALUES($1,$2)', [
        unrelated[0].id,
        'Mira sells maps in the market',
      ]);
      await q(
        'INSERT INTO session_character_tokens(session_id,character_id,token) VALUES($1,$2,$3)',
        [session, characterId, token],
      );
      await q(
        `INSERT INTO derived_memory_character_refs(session_id,character_id,row_kind,row_id) VALUES($1,$2,'registry_entry',$3)`,
        [session, characterId, first[0].id],
      );
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        await SeatCharacterRepository.redactAccount(client, owner);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
      expect(
        await q('SELECT id FROM registry_entries WHERE id=$1', [first[0].id]),
      ).toHaveLength(0);
      expect(
        await q(
          'SELECT id,supersedes_id FROM registry_entries WHERE session_id=$1 AND entity_id=$2',
          [session, 'chain-npc'],
        ),
      ).toEqual([{ id: successor[0].id, supersedes_id: null }]);
      expect(
        await q('SELECT entity_id,payload FROM registry_entries WHERE id=$1', [
          unrelated[0].id,
        ]),
      ).toEqual([
        {
          entity_id: 'unrelated-npc',
          payload: { description: 'A friendly merchant' },
        },
      ]);
      expect(
        await q('SELECT fact FROM registry_facts WHERE entry_id=$1', [
          unrelated[0].id,
        ]),
      ).toEqual([{ fact: 'Mira sells maps in the market' }]);
      expect(
        await q(
          `SELECT 1 FROM registry_entries e LEFT JOIN registry_facts f ON f.entry_id=e.id
          WHERE e.session_id=$1 AND (e.payload::text LIKE $2 OR e.search_document LIKE $2 OR f.fact LIKE $2)`,
          [session, `%${token}%`],
        ),
      ).toHaveLength(0);
      expect(
        await q('SELECT 1 FROM session_character_tokens WHERE session_id=$1', [
          session,
        ]),
      ).toHaveLength(0);
    } finally {
      await q(
        'UPDATE derived_memory_reconciliation_state SET complete=$1 WHERE singleton=true',
        [prior[0]?.complete ?? false],
      );
      await q('SELECT purge_session($1)', [session]);
      await q('DELETE FROM accounts WHERE id = ANY($1)', [[owner, roomOwner]]);
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
      const heldSummary = await q(
        'INSERT INTO scene_summaries(session_id,scene_id,summary) VALUES($1,$2,$3) RETURNING id',
        [
          session,
          'held-character-scene',
          `Held memory stays. ${'H'.repeat(32)}`,
        ],
      );
      await q(
        'INSERT INTO session_character_tokens(session_id,character_id,token) VALUES($1,$2,$3)',
        [session, characterId, 'H'.repeat(32)],
      );
      await q(
        `INSERT INTO derived_memory_character_refs(session_id,character_id,row_kind,row_id) VALUES($1,$2,'scene_summary',$3)`,
        [session, characterId, heldSummary[0].id],
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
        await q(
          'SELECT 1 FROM session_character_tokens WHERE session_id=$1 AND character_id=$2',
          [session, characterId],
        ),
      ).toHaveLength(1);
      expect(
        await q(
          'SELECT 1 FROM derived_memory_character_refs WHERE session_id=$1 AND character_id=$2',
          [session, characterId],
        ),
      ).toHaveLength(1);
      expect(
        await q('SELECT summary FROM scene_summaries WHERE session_id=$1', [
          session,
        ]),
      ).toEqual([{ summary: `Held memory stays. ${'H'.repeat(32)}` }]);
      expect(
        await q('SELECT node_id FROM session_lease WHERE session_id=$1', [
          session,
        ]),
      ).toHaveLength(0);
      await q("DELETE FROM legal_holds WHERE kind='session' AND item_id=$1", [
        session,
      ]);
      expect(
        await new SeatCharacterRepository(db).deleteOwnedCharacter(
          owner,
          characterId,
        ),
      ).toBe(true);
      expect(
        await q('SELECT 1 FROM session_character_tokens WHERE session_id=$1', [
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
      const heldSummary = await q(
        'INSERT INTO scene_summaries(session_id,scene_id,summary) VALUES($1,$2,$3) RETURNING id',
        [heldSession, 'held-scene', 'Retain while held.'],
      );
      const heldCharacter = randomUUID();
      await q(
        'INSERT INTO session_character_tokens(session_id,character_id,token) VALUES($1,$2,$3)',
        [heldSession, heldCharacter, 'L'.repeat(32)],
      );
      await q(
        `INSERT INTO derived_memory_character_refs(session_id,character_id,row_kind,row_id) VALUES($1,$2,'scene_summary',$3)`,
        [heldSession, heldCharacter, heldSummary[0].id],
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
        await q(
          'SELECT 1 FROM session_character_tokens WHERE session_id=$1 AND character_id=$2',
          [heldSession, heldCharacter],
        ),
      ).toHaveLength(1);
      expect(
        await q(
          'SELECT 1 FROM derived_memory_character_refs WHERE session_id=$1 AND character_id=$2',
          [heldSession, heldCharacter],
        ),
      ).toHaveLength(1);
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

  it('holds account deletion when an owned token mapping points at a legal-held indexed session', async () => {
    const owner = randomUUID();
    const roomOwner = randomUUID();
    const session = randomUUID();
    const characterId = randomUUID();
    const token = 'M'.repeat(32);
    await account(owner);
    await account(roomOwner);
    try {
      await q(
        'INSERT INTO account_characters(id,account_id,character) VALUES($1,$2,$3)',
        [characterId, owner, { id: characterId, name: CHAR_NAME }],
      );
      await q(
        'INSERT INTO sessions(id,owner_account_id,name,adventure_id) VALUES($1,$2,$3,$4)',
        [
          session,
          roomOwner,
          'Held token mapping',
          'adventure:01-hollow-under-marrowfell',
        ],
      );
      const summary = await q(
        'INSERT INTO scene_summaries(session_id,scene_id,summary) VALUES($1,$2,$3) RETURNING id',
        [session, 'held-token-scene', `Indexed token ${token}`],
      );
      await q(
        'INSERT INTO session_character_tokens(session_id,character_id,token) VALUES($1,$2,$3)',
        [session, characterId, token],
      );
      await q(
        `INSERT INTO derived_memory_character_refs(session_id,character_id,row_kind,row_id) VALUES($1,$2,'scene_summary',$3)`,
        [session, characterId, summary[0].id],
      );
      await q("INSERT INTO legal_holds(kind,item_id) VALUES('session',$1)", [
        session,
      ]);
      await q(
        "UPDATE accounts SET status='deleting', deletion_requested_at=now() WHERE id=$1",
        [owner],
      );

      const result = await runSweep(db, {
        store: new LocalObjectStore(dir),
        log: () => {},
      });

      expect(result?.accounts.held).toBeGreaterThan(0);
      expect(
        await q('SELECT status FROM accounts WHERE id=$1', [owner]),
      ).toEqual([{ status: 'deleting' }]);
      expect(
        await q('SELECT summary FROM scene_summaries WHERE session_id=$1', [
          session,
        ]),
      ).toEqual([{ summary: `Indexed token ${token}` }]);
      expect(
        await q(
          'SELECT 1 FROM session_character_tokens WHERE session_id=$1 AND character_id=$2',
          [session, characterId],
        ),
      ).toHaveLength(1);
      expect(
        await q(
          'SELECT 1 FROM derived_memory_character_refs WHERE session_id=$1 AND character_id=$2',
          [session, characterId],
        ),
      ).toHaveLength(1);
    } finally {
      await q('DELETE FROM legal_holds WHERE item_id=$1', [session]);
      await q('SELECT purge_session($1)', [session]);
      await q('DELETE FROM accounts WHERE id = ANY($1)', [[owner, roomOwner]]);
    }
  }, 90_000);
});
