import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { quickBuild } from '@game/rules-engine';
import { loadCatalog } from '@game/rules-engine/catalog-node';
import { SeatCharacterRepository } from '../../src/persistence/seatCharacters.js';
import { Persistence } from '../../src/persistence/index.js';
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
  it('rejects a client-chosen ID owned by another account with a neutral error', async () => {
    const f = await fixture();
    const attacker = randomUUID();
    await db.query(
      `INSERT INTO accounts(id,email,password_hash,display_name,status,is_adult,age_checked_at,terms_version,terms_accepted_at)
       VALUES($1,$2,'x','Attacker','active',true,now(),'v1',now())`,
      [attacker, `${attacker}@example.test`],
    );
    try {
      await expect(
        f.repo.saveOwnedCharacter(attacker, f.character),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    } finally {
      await db.query('SELECT purge_session($1)', [f.sessionId]);
      await db.query('DELETE FROM accounts WHERE id=ANY($1)', [
        [f.accountId, attacker],
      ]);
    }
  });

  it('admits a new late-join seat before acknowledgment and binds it in a later transaction on real Postgres', async () => {
    const f = await fixture();
    const ownerCharacter = {
      ...quickBuild(catalog, undefined, 0x31, 1).character,
      id: randomUUID(),
    };
    await db.query(
      "UPDATE sessions SET mode='solo',character_id=$2,character=$3::jsonb WHERE id=$1",
      [f.sessionId, ownerCharacter.id, ownerCharacter],
    );
    await f.repo.saveOwnedCharacter(f.accountId, ownerCharacter);
    const guestAccount = randomUUID();
    await db.query(
      `INSERT INTO accounts(id,email,password_hash,display_name,status,is_adult,age_checked_at,terms_version,terms_accepted_at)
       VALUES($1,$2,'x','Guest','active',true,now(),'v1',now())`,
      [guestAccount, `${guestAccount}@example.test`],
    );
    const guestCharacter = {
      ...quickBuild(catalog, undefined, 0x32, 1).character,
      id: randomUUID(),
    };
    const guestRevision = await f.repo.saveOwnedCharacter(
      guestAccount,
      guestCharacter,
    );
    const lease = {
      sessionId: f.sessionId,
      nodeId: 'r3b-first-seat-test',
      epoch: 1,
      expiresAt: new Date(Date.now() + 60_000),
    };
    await db.query("UPDATE sessions SET mode='solo' WHERE id=$1", [
      f.sessionId,
    ]);
    await db.query(
      'INSERT INTO session_lease(session_id,node_id,epoch,expires_at) VALUES($1,$2,$3,$4)',
      [f.sessionId, lease.nodeId, lease.epoch, lease.expiresAt],
    );
    const head = Number(
      (
        await db.query(
          'SELECT COALESCE(MAX(seq),0) AS n FROM events WHERE session_id=$1',
          [f.sessionId],
        )
      ).rows[0].n,
    );
    const store = new Persistence(db);
    const newSeatId = randomUUID();
    const written = await store.writeTurn(
      f.sessionId,
      [
        {
          turnId: randomUUID(),
          type: 'SeatJoined',
          payload: { seatId: newSeatId, accountId: guestAccount },
        },
      ],
      {},
      lease,
      [],
      head,
      undefined,
      [],
      undefined,
      'solo-to-party',
    );
    expect(written.binding).toBeUndefined();
    expect([f.seatA, f.seatB]).toContain(written.ownerBinding?.seatId);
    const beforeAck = await db.query(
      "SELECT seat_id FROM session_seat_characters WHERE session_id=$1 AND binding_status='active'",
      [f.sessionId],
    );
    expect(beforeAck.rows).toHaveLength(1);
    expect(beforeAck.rows[0]!.seat_id).not.toBe(newSeatId);
    const bound = await store.writeTurn(
      f.sessionId,
      [
        {
          turnId: randomUUID(),
          type: 'SeatCharacterBound',
          payload: { seatId: newSeatId },
        },
      ],
      {},
      lease,
      [],
      head + 1,
      undefined,
      [],
      {
        kind: 'bind',
        seatId: newSeatId,
        accountId: guestAccount,
        characterId: guestCharacter.id,
        expectedRevision: guestRevision,
      },
    );
    expect(bound.binding?.seatId).toBe(newSeatId);
    const active = await db.query(
      "SELECT seat_id,account_id FROM session_seat_characters WHERE session_id=$1 AND binding_status='active' ORDER BY account_id",
      [f.sessionId],
    );
    expect(active.rows).toHaveLength(2);
    expect(active.rows.map((row) => row.seat_id)).toContain(
      written.ownerBinding?.seatId,
    );
    expect(active.rows.map((row) => row.seat_id)).toContain(newSeatId);
  });
  it('converts a solo session before its first admitted seat is bound', async () => {
    const f = await fixture();
    const lease = {
      sessionId: f.sessionId,
      nodeId: 'r3b-conversion-test',
      epoch: 1,
      expiresAt: new Date(Date.now() + 60_000),
    };
    await db.query("UPDATE sessions SET mode='solo' WHERE id=$1", [
      f.sessionId,
    ]);
    await db.query(
      'INSERT INTO session_lease(session_id,node_id,epoch,expires_at) VALUES($1,$2,$3,$4)',
      [f.sessionId, lease.nodeId, lease.epoch, lease.expiresAt],
    );

    const store = new Persistence(db);
    await store.convertSessionToParty(f.sessionId, lease);

    expect(await store.loadSessionMode(f.sessionId)).toBe('party');
    await f.repo.bind({
      sessionId: f.sessionId,
      seatId: f.seatA,
      accountId: f.accountId,
      characterId: f.character.id,
      expectedRevision: f.revision,
    });
  });
  it('rejects first-seat admission when the solo session is no longer active', async () => {
    const f = await fixture();
    await db.query(
      "UPDATE sessions SET mode='solo', status='archived', archived_at=now() WHERE id=$1",
      [f.sessionId],
    );
    const lease = {
      sessionId: f.sessionId,
      nodeId: 'r3b-archived-admission-test',
      epoch: 1,
      expiresAt: new Date(Date.now() + 60_000),
    };
    await db.query(
      'INSERT INTO session_lease(session_id,node_id,epoch,expires_at) VALUES($1,$2,$3,$4)',
      [f.sessionId, lease.nodeId, lease.epoch, lease.expiresAt],
    );
    const head = Number(
      (
        await db.query(
          'SELECT COALESCE(MAX(seq),0) AS n FROM events WHERE session_id=$1',
          [f.sessionId],
        )
      ).rows[0].n,
    );
    const store = new Persistence(db);

    await expect(
      store.writeTurn(
        f.sessionId,
        [
          {
            turnId: randomUUID(),
            type: 'SeatJoined',
            payload: { seatId: f.seatB },
          },
        ],
        {},
        lease,
        [],
        head,
        undefined,
        [],
        undefined,
        'solo-to-party',
      ),
    ).rejects.toThrow('Solo-to-party conversion requires an active session');

    expect(await store.loadSessionMode(f.sessionId)).toBe('solo');
    const events = await db.query(
      'SELECT type FROM events WHERE session_id=$1 AND seq>$2',
      [f.sessionId, head],
    );
    expect(events.rows).toHaveLength(0);
  });
  it.each(['conversion', 'SeatJoined'] as const)(
    'rolls back solo conversion and first-seat admission when failure occurs after %s',
    async (failurePoint) => {
      const f = await fixture();
      await db.query("UPDATE sessions SET mode='solo' WHERE id=$1", [
        f.sessionId,
      ]);
      const lease = {
        sessionId: f.sessionId,
        nodeId: `r3b-atomic-${failurePoint}`,
        epoch: 1,
        expiresAt: new Date(Date.now() + 60_000),
      };
      await db.query(
        'INSERT INTO session_lease(session_id,node_id,epoch,expires_at) VALUES($1,$2,$3,$4)',
        [f.sessionId, lease.nodeId, lease.epoch, lease.expiresAt],
      );
      const failPool = {
        connect: async () => {
          const client = await db.connect();
          let injected = false;
          let converted = false;
          return new Proxy(client, {
            get(target, property) {
              if (property !== 'query') return Reflect.get(target, property);
              return async (sql: string, values?: unknown[]) => {
                const result = await target.query(sql, values as never);
                const statement = sql.toLowerCase();
                if (statement.startsWith('update sessions set mode'))
                  converted = true;
                const afterJoin =
                  statement.startsWith('insert into events') &&
                  values?.[3] === 'SeatJoined';
                const shouldFail =
                  failurePoint === 'conversion'
                    ? statement.startsWith('update sessions set mode')
                    : afterJoin;
                if (!injected && shouldFail) {
                  injected = true;
                  if (failurePoint === 'SeatJoined' && !converted)
                    throw new Error('SeatJoined was reached before conversion');
                  throw new Error(`injected failure after ${failurePoint}`);
                }
                return result;
              };
            },
          });
        },
      } as unknown as Pool;
      const store = new Persistence(failPool);
      const newSeatId = randomUUID();
      const head = Number(
        (
          await db.query(
            'SELECT COALESCE(MAX(seq),0) AS n FROM events WHERE session_id=$1',
            [f.sessionId],
          )
        ).rows[0].n,
      );
      await expect(
        store.writeTurn(
          f.sessionId,
          [
            {
              turnId: randomUUID(),
              type: 'SeatJoined',
              payload: { seatId: newSeatId, accountId: f.accountId },
            },
          ],
          {},
          lease,
          [],
          head,
          undefined,
          [],
          undefined,
          'solo-to-party',
        ),
      ).rejects.toThrow(`injected failure after ${failurePoint}`);

      const storeForRead = new Persistence(db);
      expect(await storeForRead.loadSessionMode(f.sessionId)).toBe('solo');
      const events = await db.query(
        'SELECT type FROM events WHERE session_id=$1 AND seq>$2',
        [f.sessionId, head],
      );
      expect(events.rows).toHaveLength(0);
      const bindings = await db.query(
        "SELECT 1 FROM session_seat_characters WHERE session_id=$1 AND seat_id=$2 AND binding_status='active'",
        [f.sessionId, newSeatId],
      );
      expect(bindings.rowCount).toBe(0);
    },
  );

  it('allows only one concurrent binding for a character in a session', async () => {
    const f = await fixture();
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

    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect((rejected as PromiseRejectedResult).reason).toMatchObject({
      code: 'ALREADY_BOUND',
    });
    const active = await db.query(
      `SELECT seat_id FROM session_seat_characters
        WHERE session_id=$1 AND character_id=$2 AND binding_status='active'`,
      [f.sessionId, f.character.id],
    );
    expect(active.rowCount).toBe(1);
  });

  it('returns the committed binding and releases its row on revocation without a Room cache entry', async () => {
    const f = await fixture();
    try {
      const store = new Persistence(db);
      const bound = await store.writeTurn(
        f.sessionId,
        [
          {
            seq: 3,
            turnId: randomUUID(),
            type: 'SeatCharacterBound',
            payload: { seatId: f.seatA },
          },
        ],
        {},
        undefined,
        [],
        undefined,
        undefined,
        [],
        {
          kind: 'bind',
          seatId: f.seatA,
          accountId: f.accountId,
          characterId: f.character.id,
          expectedRevision: f.revision,
        },
      );
      expect(bound.binding).toMatchObject({
        seatId: f.seatA,
        accountId: f.accountId,
        characterSnapshot: { id: f.character.id },
      });

      await store.writeTurn(
        f.sessionId,
        [
          {
            seq: 4,
            turnId: randomUUID(),
            type: 'SeatRevoked',
            payload: { seatId: f.seatA, accountId: f.accountId },
          },
          {
            seq: 5,
            turnId: randomUUID(),
            type: 'SeatCharacterReleased',
            payload: { seatId: f.seatA, reason: 'left' },
          },
        ],
        {},
        undefined,
        [],
        undefined,
        undefined,
        [],
        { kind: 'release', seatId: f.seatA, accountId: f.accountId },
      );
      expect(
        await db.query(
          "SELECT 1 FROM session_seat_characters WHERE session_id=$1 AND seat_id=$2 AND binding_status='active'",
          [f.sessionId, f.seatA],
        ),
      ).toMatchObject({ rowCount: 0 });
    } finally {
      await db.query('SELECT purge_session($1)', [f.sessionId]);
      await db.query('DELETE FROM accounts WHERE id=$1', [f.accountId]);
    }
  });
  it('rolls back binding when event append fails after the binding insert', async () => {
    const f = await fixture();
    try {
      const store = new Persistence(db);
      await expect(
        store.writeTurn(
          f.sessionId,
          [
            {
              seq: 999,
              turnId: randomUUID(),
              type: 'SeatCharacterBound',
              payload: { seatId: f.seatA },
            },
          ],
          {},
          undefined,
          [],
          undefined,
          undefined,
          [],
          {
            kind: 'bind',
            seatId: f.seatA,
            accountId: f.accountId,
            characterId: f.character.id,
            expectedRevision: f.revision,
          },
        ),
      ).rejects.toThrow('Non-contiguous event seq');
      expect(
        (
          await db.query(
            'SELECT 1 FROM session_seat_characters WHERE session_id=$1',
            [f.sessionId],
          )
        ).rowCount,
      ).toBe(0);
      expect(
        (
          await db.query(
            "SELECT 1 FROM events WHERE session_id=$1 AND type='SeatCharacterBound'",
            [f.sessionId],
          )
        ).rowCount,
      ).toBe(0);
    } finally {
      await db.query('SELECT purge_session($1)', [f.sessionId]);
      await db.query('DELETE FROM accounts WHERE id=$1', [f.accountId]);
    }
  });

  it('rolls back event append when snapshot writing fails after the event insert', async () => {
    const f = await fixture();
    try {
      const store = new Persistence(db);
      await expect(
        store.writeTurn(
          f.sessionId,
          [
            {
              seq: 2,
              turnId: randomUUID(),
              type: 'SeatCharacterBound',
              payload: { seatId: f.seatA },
            },
          ],
          { notJson: 1n },
          undefined,
          [],
          undefined,
          undefined,
          [],
          {
            kind: 'bind',
            seatId: f.seatA,
            accountId: f.accountId,
            characterId: f.character.id,
            expectedRevision: f.revision,
          },
        ),
      ).rejects.toThrow();
      expect(
        (
          await db.query(
            'SELECT 1 FROM session_seat_characters WHERE session_id=$1',
            [f.sessionId],
          )
        ).rowCount,
      ).toBe(0);
      expect(
        (
          await db.query(
            "SELECT 1 FROM events WHERE session_id=$1 AND type='SeatCharacterBound'",
            [f.sessionId],
          )
        ).rowCount,
      ).toBe(0);
    } finally {
      await db.query('SELECT purge_session($1)', [f.sessionId]);
      await db.query('DELETE FROM accounts WHERE id=$1', [f.accountId]);
    }
  });

  it('rejects binding into non-active sessions', async () => {
    const f = await fixture();
    try {
      for (const status of ['ended', 'deleting', 'archived']) {
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

  it('releases bindings on revocation after the session ends or account becomes inactive', async () => {
    for (const inactive of ['session', 'account'] as const) {
      const f = await fixture();
      try {
        await f.repo.bind({
          sessionId: f.sessionId,
          seatId: f.seatA,
          accountId: f.accountId,
          characterId: f.character.id,
          expectedRevision: f.revision,
        });

        if (inactive === 'session')
          await db.query("UPDATE sessions SET status='ended' WHERE id=$1", [
            f.sessionId,
          ]);
        else
          await db.query("UPDATE accounts SET status='deleting' WHERE id=$1", [
            f.accountId,
          ]);

        const currentSeq = Number(
          (
            await db.query(
              'SELECT MAX(seq) AS seq FROM events WHERE session_id=$1',
              [f.sessionId],
            )
          ).rows[0].seq,
        );
        await new Persistence(db).writeTurn(
          f.sessionId,
          [
            {
              seq: currentSeq + 1,
              turnId: randomUUID(),
              type: 'SeatRevoked',
              payload: { seatId: f.seatA, accountId: f.accountId },
            },
          ],
          {},
          undefined,
          [],
          undefined,
          undefined,
          [],
          { kind: 'release', seatId: f.seatA, accountId: f.accountId },
        );

        expect(
          (
            await db.query(
              'SELECT binding_status FROM session_seat_characters WHERE session_id=$1 AND seat_id=$2',
              [f.sessionId, f.seatA],
            )
          ).rows[0],
        ).toEqual({ binding_status: 'released' });
      } finally {
        await db.query('SELECT purge_session($1)', [f.sessionId]);
        await db.query('DELETE FROM accounts WHERE id=$1', [f.accountId]);
      }
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
      await expect(
        f.repo.saveOwnedCharacter(stranger, f.character),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    } finally {
      await db.query('SELECT purge_session($1)', [f.sessionId]);
      await db.query('DELETE FROM accounts WHERE id=ANY($1)', [
        [f.accountId, stranger],
      ]);
    }
  });

  it('serializes bind against the account-deletion status transition in both commit orders', async () => {
    const f = await fixture();
    const racePool = new Pool({
      connectionString: process.env.DATABASE_URL,
      application_name: 'seat-character-race-bind',
      max: 1,
    });
    const bindRepo = new SeatCharacterRepository(racePool);
    const transition = await db.connect();
    let pendingBind:
      | Promise<{ value: unknown } | { error: unknown }>
      | undefined;
    try {
      // Order 1: deletion owns the account row first. bind() must wait on its
      // FOR SHARE lock, then observe deleting after the transition commits.
      await transition.query('BEGIN');
      const transitioned = await transition.query(
        `UPDATE accounts SET status='deleting',deletion_requested_at=now() WHERE id=$1 RETURNING status`,
        [f.accountId],
      );
      expect(transitioned.rows[0]?.status).toBe('deleting');
      pendingBind = bindRepo
        .bind({
          sessionId: f.sessionId,
          seatId: f.seatA,
          accountId: f.accountId,
          characterId: f.character.id,
          expectedRevision: f.revision,
        })
        .then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );

      const deadline = Date.now() + 5000;
      let waiting = false;
      while (Date.now() < deadline) {
        const activity = await db.query<{ waiting: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM pg_stat_activity
             WHERE application_name='seat-character-race-bind'
               AND wait_event_type='Lock'
           ) AS waiting`,
        );
        if (activity.rows[0]!.waiting) {
          waiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      await transition.query('COMMIT');
      const bindResult = await pendingBind;
      expect(bindResult).toHaveProperty('error');
      expect(bindResult.error).toMatchObject({ code: 'ACCOUNT_INACTIVE' });

      const result = await runAccountDeletions(
        { db, store: {} as never, now: new Date(), log: () => {} },
        [f.accountId],
      );
      expect(result).toMatchObject({ deleted: 1, failed: 0, held: 0 });
      const survivors = await db.query(
        `SELECT 1 FROM session_seat_characters
         WHERE binding_status='active' AND account_id=$1`,
        [f.accountId],
      );
      expect(survivors.rowCount).toBe(0);

      // Order 2: a bind commits before deletion takes the account lock. The
      // deletion job must scrub that newly-created binding rather than leave
      // an active account link behind.
      const reverse = await fixture();
      try {
        const bound = await reverse.repo.bind({
          sessionId: reverse.sessionId,
          seatId: reverse.seatA,
          accountId: reverse.accountId,
          characterId: reverse.character.id,
          expectedRevision: reverse.revision,
        });
        await db.query(
          `UPDATE accounts SET status='deleting',deletion_requested_at=now() WHERE id=$1`,
          [reverse.accountId],
        );
        const deleted = await runAccountDeletions(
          { db, store: {} as never, now: new Date(), log: () => {} },
          [reverse.accountId],
        );
        expect(deleted).toMatchObject({ deleted: 1, failed: 0, held: 0 });
        const reverseSurvivors = await db.query(
          `SELECT 1 FROM session_seat_characters
           WHERE id=$1 AND (binding_status='active' OR account_id IS NOT NULL)`,
          [bound.bindingId],
        );
        expect(reverseSurvivors.rowCount).toBe(0);
      } finally {
        await db.query('SELECT purge_session($1)', [reverse.sessionId]);
        await db.query('DELETE FROM accounts WHERE id=$1', [reverse.accountId]);
      }
    } finally {
      await transition.query('ROLLBACK').catch(() => {});
      if (pendingBind) await pendingBind;
      transition.release();
      await racePool.end();
      await db.query('SELECT purge_session($1)', [f.sessionId]);
      await db.query('DELETE FROM accounts WHERE id=$1', [f.accountId]);
    }
  }, 15_000);

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
      expect(bindingAfter.character_snapshot).not.toHaveProperty('id');
      expect(bindingAfter.character_snapshot.abilities).toEqual(
        f.character.abilities,
      );
      // Account deletion removes the reusable sheet because it contains player PII.
      const deletedCharacter = await db.query(
        'SELECT 1 FROM account_characters WHERE id=$1',
        [f.character.id],
      );
      expect(deletedCharacter.rowCount).toBe(0);
      expect(
        await db.query(
          `SELECT 1 FROM session_seat_characters
           WHERE account_id=$1 OR character_id=$2
              OR (binding_status='active' AND account_id=$1)`,
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
