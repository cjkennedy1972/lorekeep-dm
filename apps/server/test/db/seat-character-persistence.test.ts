import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { quickBuild } from '@game/rules-engine';
import { loadCatalog } from '@game/rules-engine/catalog-node';
import { SeatCharacterRepository } from '../../src/persistence/seatCharacters.js';

const db = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
afterAll(async () => db.end());
const catalog = loadCatalog();

async function fixture() {
  const accountId = randomUUID();
  const sessionId = randomUUID();
  const seatA = randomUUID();
  const seatB = randomUUID();
  await db.query(
    `INSERT INTO accounts(id,email,password_hash,display_name,is_adult,age_checked_at,terms_version,terms_accepted_at)
     VALUES($1,$2,'x','Test',true,now(),'v1',now())`, [accountId, `${accountId}@example.test`]);
  await db.query("INSERT INTO sessions(id,owner_account_id,name,status,mode) VALUES($1,$2,'test','active','party')", [sessionId, accountId]);
  for (const seatId of [seatA, seatB]) {
    const seq = Number((await db.query('SELECT COALESCE(MAX(seq),0)+1 AS n FROM events WHERE session_id=$1', [sessionId])).rows[0].n);
    await db.query("INSERT INTO events(session_id,seq,turn_id,type,payload) VALUES($1,$2,$3,'SeatJoined',$4)", [sessionId, seq, randomUUID(), { seatId, accountId }]);
  }
  const character = { ...quickBuild(catalog, undefined, 0x28, 1).character, id: randomUUID() };
  const repo = new SeatCharacterRepository(db);
  const revision = await repo.saveOwnedCharacter(accountId, character);
  return { accountId, sessionId, seatA, seatB, character, revision, repo };
}

describe('party seat-character persistence', () => {
  it('serializes simultaneous bindings so one character cannot bind to two seats', async () => {
    const f = await fixture();
    try {
      const results = await Promise.allSettled([
        f.repo.bind({ sessionId: f.sessionId, seatId: f.seatA, accountId: f.accountId, characterId: f.character.id, expectedRevision: f.revision }),
        f.repo.bind({ sessionId: f.sessionId, seatId: f.seatB, accountId: f.accountId, characterId: f.character.id, expectedRevision: f.revision }),
      ]);
      expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((x) => x.status === 'rejected')).toHaveLength(1);
      expect((await db.query("SELECT count(*)::int AS n FROM session_seat_characters WHERE session_id=$1 AND binding_status='active'", [f.sessionId])).rows[0].n).toBe(1);
    } finally { await db.query('DELETE FROM sessions WHERE id=$1', [f.sessionId]); await db.query('DELETE FROM accounts WHERE id=$1', [f.accountId]); }
  });

  it('enforces one active character per seat and rejects a foreign account owner', async () => {
    const f = await fixture();
    const stranger = randomUUID();
    await db.query(`INSERT INTO accounts(id,email,password_hash,display_name,is_adult,age_checked_at,terms_version,terms_accepted_at) VALUES($1,$2,'x','Stranger',true,now(),'v1',now())`, [stranger, `${stranger}@example.test`]);
    try {
      await expect(f.repo.bind({ sessionId: f.sessionId, seatId: f.seatA, accountId: stranger, characterId: f.character.id, expectedRevision: f.revision })).rejects.toMatchObject({ code: 'NOT_SEATED' });
      await f.repo.bind({ sessionId: f.sessionId, seatId: f.seatA, accountId: f.accountId, characterId: f.character.id, expectedRevision: f.revision });
      const another = { ...f.character, id: randomUUID() };
      await f.repo.saveOwnedCharacter(f.accountId, another);
      await expect(f.repo.bind({ sessionId: f.sessionId, seatId: f.seatA, accountId: f.accountId, characterId: another.id, expectedRevision: 1 })).rejects.toMatchObject({ code: 'ALREADY_BOUND' });
      await expect(f.repo.saveOwnedCharacter(stranger, f.character, f.revision)).rejects.toMatchObject({ code: 'NOT_OWNER' });
    } finally { await db.query('DELETE FROM sessions WHERE id=$1', [f.sessionId]); await db.query('DELETE FROM accounts WHERE id=ANY($1)', [[f.accountId, stranger]]); }
  });

  it('releases and redacts without rewriting the immutable session mechanics', async () => {
    const f = await fixture();
    try {
      const bound = await f.repo.bind({ sessionId: f.sessionId, seatId: f.seatA, accountId: f.accountId, characterId: f.character.id, expectedRevision: f.revision });
      const snapshotBefore = (await db.query('SELECT character_snapshot FROM session_seat_characters WHERE id=$1', [bound.bindingId])).rows[0].character_snapshot;
      expect(snapshotBefore).not.toHaveProperty('hp');
      expect(snapshotBefore).not.toHaveProperty('conditions');
      expect(await f.repo.release(f.sessionId, f.seatA)).toBe(true);
      await db.query("UPDATE session_seat_characters SET account_id=NULL,character_id=NULL,character_revision=NULL,binding_status='redacted',character_snapshot=jsonb_set(character_snapshot - 'id' - 'name','{name}','\"Deleted player\"'::jsonb) WHERE id=$1", [bound.bindingId]);
      const redacted = (await db.query('SELECT account_id,character_id,character_snapshot,binding_status FROM session_seat_characters WHERE id=$1', [bound.bindingId])).rows[0];
      expect(redacted).toMatchObject({ account_id: null, character_id: null, binding_status: 'redacted' });
      expect(redacted.character_snapshot.abilities).toEqual(snapshotBefore.abilities);
      expect((await db.query('SELECT count(*)::int AS n FROM events WHERE session_id=$1', [f.sessionId])).rows[0].n).toBe(2);
    } finally { await db.query('DELETE FROM sessions WHERE id=$1', [f.sessionId]); await db.query('DELETE FROM accounts WHERE id=$1', [f.accountId]); }
  });
});
