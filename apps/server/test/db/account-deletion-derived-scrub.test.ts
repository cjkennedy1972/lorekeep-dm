import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LlmAdapter } from '../../src/llm/adapter.js';
import { closeScene } from '../../src/dm/summarize.js';
import { RegistryMemory } from '../../src/dm/memory.js';
import { LocalObjectStore } from '../../src/storage/objectStore.js';
import { runSweep } from '../../src/retention/sweeper.js';

const TYPED = 'the vault code is moonfall-ZQ7';
const CHAR_NAME = 'Mirelle Ashgrove';
let db: Pool;
let dir: string;

const failingAdapter: LlmAdapter = {
  capabilities: () => ({ streaming: true, nativeTools: true, jsonSchema: true }),
  probe: async () => false,
  // eslint-disable-next-line require-yield
  async *complete() {
    throw new Error('summary endpoint unavailable');
  },
};

const q = async (sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows;

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

describe('account deletion scrubs derived tables', () => {
  it('removes a deleted player’s typed text and character name from scene summaries and the registry', async () => {
    const gone = randomUUID();
    const heir = randomUUID();
    const session = randomUUID();
    const charId = `char_${randomUUID().slice(0, 8)}`;
    await account(gone);
    await account(heir);
    try {
      await q(
        'INSERT INTO sessions(id,owner_account_id,name,adventure_id,character_id) VALUES($1,$2,$3,$4,$5)',
        [session, gone, 'Derived', 'adventure:01-hollow-under-marrowfell', charId],
      );
      await q(
        "INSERT INTO events(session_id,seq,turn_id,type,payload) VALUES($1,1,$2,'SeatJoined',$3),($1,2,$2,'SeatJoined',$4),($1,3,$5,'ActionAccepted',$6)",
        [
          session,
          randomUUID(),
          { seatId: randomUUID(), accountId: heir, displayName: 'Heir', presence: 'offline' },
          { seatId: randomUUID(), accountId: gone, displayName: 'Acct', presence: 'offline' },
          randomUUID(),
          { accountId: gone, actionId: 'a1', text: TYPED, playerName: 'Mirelle' },
        ],
      );
      await q('INSERT INTO snapshots(session_id,seq,state) VALUES($1,3,$2)', [
        session,
        { lastPlayerText: TYPED, party: { [gone]: { id: charId, name: CHAR_NAME } } },
      ]);

      await closeScene({
        db,
        sessionId: session,
        sceneId: 'scene-marowfell-well',
        adapter: failingAdapter,
        events: [
          { type: 'ActionAccepted', payload: { accountId: gone, text: TYPED, playerName: 'Mirelle' } },
          { type: 'CharacterCreated', payload: { name: CHAR_NAME } },
        ],
      });
      await new RegistryMemory(db).upsert(session, {
        kind: 'npc',
        id: 'npc_guard',
        after: {
          id: 'npc_guard',
          name: 'Guard Captain',
          role: 'guard',
          disposition: 'neutral',
          facts: [`${CHAR_NAME} said: ${TYPED}`],
        },
      });

      expect(JSON.stringify(await q('SELECT summary FROM scene_summaries WHERE session_id=$1', [session]))).toContain(TYPED);

      await q("UPDATE accounts SET status='deleting', deletion_requested_at=now() WHERE id=$1", [gone]);
      await runSweep(db, { store: new LocalObjectStore(dir), log: () => {} });

      expect(await q('SELECT 1 FROM accounts WHERE id=$1', [gone])).toHaveLength(0);
      expect(await q('SELECT owner_account_id FROM sessions WHERE id=$1', [session])).toEqual([
        { owner_account_id: heir },
      ]);
      const derived = JSON.stringify([
        await q('SELECT summary FROM scene_summaries WHERE session_id=$1', [session]),
        await q(
          'SELECT name, aliases, payload::text AS payload, search_document FROM registry_entries WHERE session_id=$1',
          [session],
        ),
        await q(
          'SELECT f.fact FROM registry_facts f JOIN registry_entries e ON e.id=f.entry_id WHERE e.session_id=$1',
          [session],
        ),
      ]);
      expect(derived).not.toContain(TYPED);
      expect(derived).not.toContain(CHAR_NAME);
    } finally {
      await q('SELECT purge_session($1)', [session]);
      await q('DELETE FROM accounts WHERE id = ANY($1)', [[gone, heir]]);
    }
  });
});
