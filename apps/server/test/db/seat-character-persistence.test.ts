import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { quickBuild } from '@game/rules-engine';
import { loadCatalog } from '@game/rules-engine/catalog-node';
import { SeatCharacterRepository } from '../../src/persistence/seatCharacters.js';
import { runAccountDeletions } from '../../src/retention/jobs/accountDeletion.js';

const db = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
afterAll(async () => db.end());
const catalog = loadCatalog();

async function fixture() {
  const accountId = randomUUID();
  const sessionId = randomUUID();
  const seatA = randomUUID();
  const seatB = randomUUID();
  await db.query(
    `INSERT INTO accounts(id,email,password_hash,display_name,status,is_adult,age_checked_at,terms_version,terms_accepted_at)
     VALUES($1,$2,'x','Test','active',true,now(),'v1',now())`,
    [accountId, `${accountId}@example.test`],
  );
  await db.query(
    "INSERT INTO sessions(id,owner_account_id,name,status,mode) VALUES($1,$2,'test','active','party')",
    [sessionId, accountId],
  );
  for (const seatId of [seatA, seatB]) {
    const seq = Number(
      (
        await db.query(
          'SELECT COALESCE(MAX(seq),0)+1 AS n FROM events WHERE session_id=$1',
          [sessionId],
        )
      ).rows[0].n,
    );
    await db.query(
      "INSERT INTO events(session_id,seq,turn_id,type,payload) VALUES($1,$2,$3,'SeatJoined',$4)",
      [sessionId, seq, randomUUID(), { seatId, accountId }],
    );
  }
  const character = {
    ...quickBuild(catalog, undefined, 0x28, 1).character,
    id: randomUUID(),
  };
  const repo = new SeatCharacterRepository(db);
  const revision = await repo.saveOwnedCharacter(accountId, character);
  return { accountId, sessionId, seatA, seatB, character, revision, repo };
}

describe('party seat-character persistence', () => {
  it('rejects binding into ended or deleting sessions', async () => {
    const f = await fixture();
    try {
      for (const status of ['ended', 'deleting']) {
        await db.query('UPDATE sessions SET status=$2 WHERE id=$1', [
          f.sessionId,
          status,
        ]);
        await expect(
          f.repo.bind({
            sessionId: f.sessionId,
            seatId: f.seatA,
            accountId: f.accountId,
            characterId: f.character.id,
            expectedRevision: f.revision,
          }),
        ).rejects.toMatchObject({ code: 'SESSION_INACTIVE' });
      }
    } finally {
      await db.query('SELECT purge_session($1)', [f.sessionId]);
      await db.query('DELETE FROM accounts WHERE id=$1', [f.accountId]);
    }
  });

  it('serializes simultaneous bindings so one character cannot bind to two seats', async () => {
    const f = await fixture();
    try {
      const results = await Promise.allSettled([
        f.repo.bind({
          sessionId: f.sessionId,
          seatId: f.seatA,
          accountId: f.accountId,
          characterId: f.character.id,
          expectedRevision: f.revision,
        }),
        f.repo.bind({
          sessionId: f.sessionId,
          seatId: f.seatB,
          accountId: f.accountId,
          characterId: f.character.id,
          expectedRevision: f.revision,
        }),
      ]);
      expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((x) => x.status === 'rejected')).toHaveLength(1);
      expect(
        (
          await db.query(
            "SELECT count(*)::int AS n FROM session_seat_characters WHERE session_id=$1 AND binding_status='active'",
            [f.sessionId],
          )
        ).rows[0].n,
      ).toBe(1);
    } finally {
      await db.query('SELECT purge_session($1)', [f.sessionId]);
      await db.query('DELETE FROM accounts WHERE id=$1', [f.accountId]);
    }
  });

  it('enforces one active character per seat and rejects a foreign account owner', async () => {
    const f = await fixture();
    const stranger = randomUUID();
    const strangerSeat = randomUUID();
    await db.query(
      `INSERT INTO accounts(id,email,password_hash,display_name,status,is_adult,age_checked_at,terms_version,terms_accepted_at) VALUES($1,$2,'x','Stranger','active',true,now(),'v1',now())`,
      [stranger, `${stranger}@example.test`],
    );
    await db.query(
      "INSERT INTO events(session_id,seq,turn_id,type,payload) VALUES($1,(SELECT COALESCE(MAX(seq),0)+1 FROM events WHERE session_id=$1),$2,'SeatJoined',$3)",
      [
        f.sessionId,
        randomUUID(),
        { seatId: strangerSeat, accountId: stranger },
      ],
    );
    try {
      await expect(
        f.repo.bind({
          sessionId: f.sessionId,
          seatId: f.seatA,
          accountId: stranger,
          characterId: f.character.id,
          expectedRevision: f.revision,
        }),
      ).rejects.toMatchObject({ code: 'NOT_SEATED' });
      await f.repo.bind({
        sessionId: f.sessionId,
        seatId: f.seatA,
        accountId: f.accountId,
        characterId: f.character.id,
        expectedRevision: f.revision,
      });
      const another = { ...f.character, id: randomUUID() };
      await f.repo.saveOwnedCharacter(f.accountId, another);
      await expect(
        f.repo.bind({
          sessionId: f.sessionId,
          seatId: f.seatA,
          accountId: f.accountId,
          characterId: another.id,
          expectedRevision: 1,
        }),
      ).rejects.toMatchObject({ code: 'ALREADY_BOUND' });
      await expect(
        f.repo.bind({
          sessionId: f.sessionId,
          seatId: strangerSeat,
          accountId: stranger,
          characterId: f.character.id,
          expectedRevision: f.revision,
        }),
      ).rejects.toMatchObject({ code: 'NOT_OWNER' });
      await expect(
        f.repo.saveOwnedCharacter(stranger, f.character, f.revision),
      ).rejects.toMatchObject({ code: 'NOT_OWNER' });
    } finally {
      await db.query('SELECT purge_session($1)', [f.sessionId]);
      await db.query('DELETE FROM accounts WHERE id=ANY($1)', [
        [f.accountId, stranger],
      ]);
    }
  });

  it('blocks source deletion while bound, then allows it after the owner releases', async () => {
    const f = await fixture();
    const stranger = randomUUID();
    await db.query(
      `INSERT INTO accounts(id,email,password_hash,display_name,status,is_adult,age_checked_at,terms_version,terms_accepted_at)
       VALUES($1,$2,'x','Stranger','active',true,now(),'v1',now())`,
      [stranger, `${stranger}@example.test`],
    );
    try {
      await f.repo.bind({
        sessionId: f.sessionId,
        seatId: f.seatA,
        accountId: f.accountId,
        characterId: f.character.id,
        expectedRevision: f.revision,
      });
      await expect(
        f.repo.release(f.sessionId, f.seatA, stranger),
      ).resolves.toBe(false);
      await expect(
        f.repo.deleteOwnedCharacter(f.accountId, f.character.id),
      ).rejects.toMatchObject({ code: 'CHARACTER_BOUND' });
      expect(await f.repo.release(f.sessionId, f.seatA, f.accountId)).toBe(
        true,
      );
      expect(
        await f.repo.deleteOwnedCharacter(f.accountId, f.character.id),
      ).toBe(true);
      const released = (
        await db.query(
          'SELECT binding_status,account_id,character_id FROM session_seat_characters WHERE session_id=$1',
          [f.sessionId],
        )
      ).rows[0];
      expect(released).toMatchObject({
        binding_status: 'released',
        account_id: f.accountId,
        character_id: null,
      });
    } finally {
      await db.query('SELECT purge_session($1)', [f.sessionId]);
      await db.query('DELETE FROM accounts WHERE id=ANY($1)', [
        [f.accountId, stranger],
      ]);
    }
  });

  it('rejects binds while account deletion is pending, runs the real scrub, and preserves replay mechanics', async () => {
    const f = await fixture();
    const heir = randomUUID();
    await db.query(
      `INSERT INTO accounts(id,email,password_hash,display_name,status,is_adult,age_checked_at,terms_version,terms_accepted_at)
       VALUES($1,$2,'x','Heir','active',true,now(),'v1',now())`,
      [heir, `${heir}@example.test`],
    );
    const binding = await f.repo.bind({
      sessionId: f.sessionId,
      seatId: f.seatA,
      accountId: f.accountId,
      characterId: f.character.id,
      expectedRevision: f.revision,
    });
    await db.query(
      `INSERT INTO events(session_id,seq,turn_id,type,payload)
       VALUES($1,3,$2,'SeatJoined',$3)`,
      [f.sessionId, randomUUID(), { seatId: randomUUID(), accountId: heir }],
    );
    const before = (
      await db.query(
        'SELECT seq,type FROM events WHERE session_id=$1 ORDER BY seq',
        [f.sessionId],
      )
    ).rows;
    const state = { mechanics: { round: 2, party: ['anonymous-seat'] } };
    await db.query(
      'INSERT INTO snapshots(session_id,seq,state) VALUES($1,3,$2)',
      [f.sessionId, state],
    );
    const snapshotBefore = (
      await db.query('SELECT state FROM snapshots WHERE session_id=$1', [
        f.sessionId,
      ])
    ).rows[0].state;

    try {
      await db.query(
        `UPDATE accounts SET status='deleting',deletion_requested_at=now() WHERE id=$1`,
        [f.accountId],
      );
      await expect(
        f.repo.bind({
          sessionId: f.sessionId,
          seatId: f.seatB,
          accountId: f.accountId,
          characterId: f.character.id,
          expectedRevision: f.revision,
        }),
      ).rejects.toMatchObject({ code: 'ACCOUNT_INACTIVE' });
      await expect(
        f.repo.saveOwnedCharacter(f.accountId, {
          ...f.character,
          id: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: 'ACCOUNT_INACTIVE' });

      const result = await runAccountDeletions(
        {
          db,
          store: {} as never,
          now: new Date(),
          log: () => {},
        },
        [f.accountId],
      );
      expect(result).toMatchObject({ deleted: 1, failed: 0, held: 0 });
      const deletedAccount = await db.query(
        'SELECT 1 FROM accounts WHERE id=$1',
        [f.accountId],
      );
      expect(deletedAccount.rowCount).toBe(0);
      const bindingAfter = (
        await db.query(
          'SELECT account_id,character_id,character_revision,binding_status,character_snapshot FROM session_seat_characters WHERE id=$1',
          [binding.bindingId],
        )
      ).rows[0];
      expect(bindingAfter).toMatchObject({
        account_id: null,
        character_id: null,
        character_revision: null,
        binding_status: 'redacted',
      });
      expect(bindingAfter.character_snapshot.name).toBe('Deleted player');
      expect(bindingAfter.character_snapshot.abilities).toEqual(
        f.character.abilities,
      );
      expect(
        (
          await db.query('SELECT 1 FROM account_characters WHERE id=$1', [
            f.character.id,
          ])
        ).rowCount,
      ).toBe(0);
      expect(
        await db.query(
          'SELECT 1 FROM session_seat_characters WHERE account_id=$1 OR character_id=$2',
          [f.accountId, f.character.id],
        ),
      ).toMatchObject({ rowCount: 0 });
      const after = (
        await db.query(
          'SELECT seq,type FROM events WHERE session_id=$1 ORDER BY seq',
          [f.sessionId],
        )
      ).rows;
      expect(after).toEqual(before);
      expect(
        JSON.stringify(
          (
            await db.query('SELECT payload FROM events WHERE session_id=$1', [
              f.sessionId,
            ])
          ).rows,
        ),
      ).not.toContain(f.accountId);
      expect(
        (
          await db.query('SELECT state FROM snapshots WHERE session_id=$1', [
            f.sessionId,
          ])
        ).rows[0].state,
      ).toEqual(snapshotBefore);
    } finally {
      await db.query('SELECT purge_session($1)', [f.sessionId]);
      await db.query('DELETE FROM accounts WHERE id=$1', [f.accountId]);
      await db.query('DELETE FROM accounts WHERE id=$1', [heir]);
    }
  });

  it('releases without rewriting the immutable session mechanics', async () => {
    const f = await fixture();
    try {
      const bound = await f.repo.bind({
        sessionId: f.sessionId,
        seatId: f.seatA,
        accountId: f.accountId,
        characterId: f.character.id,
        expectedRevision: f.revision,
      });
      const snapshotBefore = (
        await db.query(
          'SELECT character_snapshot FROM session_seat_characters WHERE id=$1',
          [bound.bindingId],
        )
      ).rows[0].character_snapshot;
      expect(snapshotBefore).not.toHaveProperty('hp');
      expect(snapshotBefore).not.toHaveProperty('conditions');
      expect(snapshotBefore).not.toHaveProperty('backgroundId');
      expect(await f.repo.release(f.sessionId, f.seatA, f.accountId)).toBe(
        true,
      );
      const released = (
        await db.query(
          'SELECT account_id,character_id,character_snapshot,binding_status FROM session_seat_characters WHERE id=$1',
          [bound.bindingId],
        )
      ).rows[0];
      expect(released).toMatchObject({
        account_id: f.accountId,
        character_id: f.character.id,
        binding_status: 'released',
      });
      expect(released.character_snapshot.abilities).toEqual(
        snapshotBefore.abilities,
      );
      expect(
        (
          await db.query(
            'SELECT count(*)::int AS n FROM events WHERE session_id=$1',
            [f.sessionId],
          )
        ).rows[0].n,
      ).toBe(2);
    } finally {
      await db.query('SELECT purge_session($1)', [f.sessionId]);
      await db.query('DELETE FROM accounts WHERE id=$1', [f.accountId]);
    }
  });
});
