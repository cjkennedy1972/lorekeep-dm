import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { quickBuild } from '@game/rules-engine';
import { loadCatalog } from '@game/rules-engine/catalog-node';
import {
  SeatCharacterError,
  SeatCharacterRepository,
} from '../../src/persistence/seatCharacters.js';
import { Persistence } from '../../src/persistence/index.js';
import { runAccountDeletions } from '../../src/retention/jobs/accountDeletion.js';

const db = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
const catalog = loadCatalog();
const repo = new SeatCharacterRepository(db);
const created = { accounts: [] as string[], sessions: [] as string[] };

afterAll(async () => {
  for (const sessionId of created.sessions)
    await db.query('SELECT purge_session($1)', [sessionId]);
  for (const accountId of created.accounts)
    await db.query('DELETE FROM accounts WHERE id=$1', [accountId]);
  await db.end();
});

async function makeAccount(status = 'active') {
  const accountId = randomUUID();
  await db.query(
    `INSERT INTO accounts(id,email,password_hash,display_name,status,is_adult,age_checked_at,terms_version,terms_accepted_at)
     VALUES($1,$2,'x','Test',$3,true,now(),'v1',now())`,
    [accountId, `${accountId}@example.test`, status],
  );
  created.accounts.push(accountId);
  return accountId;
}

async function makeSession(ownerAccountId: string) {
  const sessionId = randomUUID();
  await db.query(
    "INSERT INTO sessions(id,owner_account_id,name,status,mode) VALUES($1,$2,'acceptance','active','party')",
    [sessionId, ownerAccountId],
  );
  created.sessions.push(sessionId);
  return sessionId;
}

async function appendEvent(sessionId: string, type: string, payload: object) {
  const seq = Number(
    (
      await db.query<{ n: number }>(
        'SELECT COALESCE(MAX(seq),0)+1 AS n FROM events WHERE session_id=$1',
        [sessionId],
      )
    ).rows[0]!.n,
  );
  await db.query(
    'INSERT INTO events(session_id,seq,turn_id,type,payload) VALUES($1,$2,$3,$4,$5::jsonb)',
    [sessionId, seq, randomUUID(), type, JSON.stringify(payload)],
  );
}

async function seat(sessionId: string, accountId: string) {
  const seatId = randomUUID();
  await appendEvent(sessionId, 'SeatJoined', { seatId, accountId });
  return seatId;
}

let seedCounter = 0x40;
async function ownedCharacter(accountId: string) {
  const character = {
    ...quickBuild(catalog, undefined, seedCounter++, 1).character,
    id: randomUUID(),
  };
  const revision = await repo.saveOwnedCharacter(accountId, character);
  return { character, revision };
}

function bindInput(
  sessionId: string,
  seatId: string,
  accountId: string,
  characterId: string,
  expectedRevision: number,
) {
  return { sessionId, seatId, accountId, characterId, expectedRevision };
}

async function activeRows(sessionId: string) {
  return (
    await db.query<{
      id: string;
      seat_id: string;
      account_id: string;
      character_id: string;
    }>(
      `SELECT id,seat_id,account_id,character_id FROM session_seat_characters
        WHERE session_id=$1 AND binding_status='active' ORDER BY seat_id`,
      [sessionId],
    )
  ).rows;
}

async function errorCodeOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof SeatCharacterError) return error.code;
    throw error;
  }
  throw new Error('expected a SeatCharacterError');
}

describe('ADR-035 step 5: party seat binding acceptance', () => {
  it.each([2, 3, 4, 5, 6])(
    'binds one distinct owned character to each of %i seats',
    async (seatCount) => {
      const owner = await makeAccount();
      const sessionId = await makeSession(owner);
      const players = [owner];
      for (let i = 1; i < seatCount; i++) players.push(await makeAccount());
      const seats = [];
      const sheets = [];
      for (const accountId of players) {
        const seatId = await seat(sessionId, accountId);
        seats.push({ seatId, accountId });
        sheets.push(await ownedCharacter(accountId));
      }

      const results = await Promise.all(
        seats.map((entry, index) =>
          repo.bind(
            bindInput(
              sessionId,
              entry.seatId,
              entry.accountId,
              sheets[index]!.character.id,
              sheets[index]!.revision,
            ),
          ),
        ),
      );

      expect(results).toHaveLength(seatCount);
      const rows = await activeRows(sessionId);
      expect(rows).toHaveLength(seatCount);
      expect(new Set(rows.map((row) => row.seat_id)).size).toBe(seatCount);
      expect(new Set(rows.map((row) => row.character_id)).size).toBe(seatCount);
      for (const entry of seats) {
        const row = rows.find(
          (candidate) => candidate.seat_id === entry.seatId,
        );
        expect(row).toMatchObject({ account_id: entry.accountId });
      }
    },
  );

  it('lets one account hold different characters in different sessions while each seat keeps one live binding', async () => {
    const owner = await makeAccount();
    const first = await makeSession(owner);
    const second = await makeSession(owner);
    const seatFirst = await seat(first, owner);
    const seatSecond = await seat(second, owner);
    const sheetA = await ownedCharacter(owner);
    const sheetB = await ownedCharacter(owner);

    await repo.bind(
      bindInput(first, seatFirst, owner, sheetA.character.id, sheetA.revision),
    );
    // The same reusable sheet may be bound in another session: live bindings are per session.
    await repo.bind(
      bindInput(
        second,
        seatSecond,
        owner,
        sheetA.character.id,
        sheetA.revision,
      ),
    );
    expect(await activeRows(first)).toHaveLength(1);
    expect(await activeRows(second)).toHaveLength(1);

    // A second character cannot replace the seat's live binding within the same session.
    expect(
      await errorCodeOf(
        repo.bind(
          bindInput(
            first,
            seatFirst,
            owner,
            sheetB.character.id,
            sheetB.revision,
          ),
        ),
      ),
    ).toBe('ALREADY_BOUND');
    expect(await activeRows(first)).toMatchObject([
      { seat_id: seatFirst, character_id: sheetA.character.id },
    ]);
  });

  it('serializes concurrent binds for one seat so exactly one live binding survives', async () => {
    const owner = await makeAccount();
    const sessionId = await makeSession(owner);
    const seatId = await seat(sessionId, owner);
    const sheets = [];
    for (let i = 0; i < 4; i++) sheets.push(await ownedCharacter(owner));

    const results = await Promise.allSettled(
      sheets.map((sheet) =>
        repo.bind(
          bindInput(
            sessionId,
            seatId,
            owner,
            sheet.character.id,
            sheet.revision,
          ),
        ),
      ),
    );

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const result of results) {
      if (result.status === 'rejected')
        expect(result.reason).toMatchObject({ code: 'ALREADY_BOUND' });
    }
    expect(await activeRows(sessionId)).toHaveLength(1);
  });

  it('refuses forged, foreign, unknown and stale character ids without changing any live binding', async () => {
    const owner = await makeAccount();
    const guest = await makeAccount();
    const sessionId = await makeSession(owner);
    const ownerSeat = await seat(sessionId, owner);
    const guestSeat = await seat(sessionId, guest);
    const ownerSheet = await ownedCharacter(owner);
    await repo.bind(
      bindInput(
        sessionId,
        ownerSeat,
        owner,
        ownerSheet.character.id,
        ownerSheet.revision,
      ),
    );
    const before = await activeRows(sessionId);

    // Foreign: a real character id owned by another account.
    expect(
      await errorCodeOf(
        repo.bind(
          bindInput(
            sessionId,
            guestSeat,
            guest,
            ownerSheet.character.id,
            ownerSheet.revision,
          ),
        ),
      ),
    ).toBe('NOT_OWNER');
    // Unknown: an id that has no character row at all.
    expect(
      await errorCodeOf(
        repo.bind(bindInput(sessionId, guestSeat, guest, randomUUID(), 1)),
      ),
    ).toBe('NOT_FOUND');
    // Stale: the owner's own sheet at the wrong revision.
    expect(
      await errorCodeOf(
        repo.bind(
          bindInput(
            sessionId,
            ownerSeat,
            owner,
            ownerSheet.character.id,
            ownerSheet.revision + 1,
          ),
        ),
      ),
    ).toBe('STALE_REVISION');

    expect(await activeRows(sessionId)).toEqual(before);
    expect(guestSeat).not.toBe(ownerSeat);
  });

  it('refuses binds from unseated, revoked, and suspended accounts', async () => {
    const owner = await makeAccount();
    const unseated = await makeAccount();
    const revoked = await makeAccount();
    const suspended = await makeAccount();
    const sessionId = await makeSession(owner);
    const revokedSeat = await seat(sessionId, revoked);
    await appendEvent(sessionId, 'SeatRevoked', {
      seatId: revokedSeat,
      accountId: revoked,
    });
    const suspendedSeat = await seat(sessionId, suspended);
    const sheets = {
      unseated: await ownedCharacter(unseated),
      revoked: await ownedCharacter(revoked),
      suspended: await ownedCharacter(suspended),
    };
    await db.query("UPDATE accounts SET status='suspended' WHERE id=$1", [
      suspended,
    ]);

    expect(
      await errorCodeOf(
        repo.bind(
          bindInput(
            sessionId,
            randomUUID(),
            unseated,
            sheets.unseated.character.id,
            sheets.unseated.revision,
          ),
        ),
      ),
    ).toBe('NOT_SEATED');
    expect(
      await errorCodeOf(
        repo.bind(
          bindInput(
            sessionId,
            revokedSeat,
            revoked,
            sheets.revoked.character.id,
            sheets.revoked.revision,
          ),
        ),
      ),
    ).toBe('NOT_SEATED');
    expect(
      await errorCodeOf(
        repo.bind(
          bindInput(
            sessionId,
            suspendedSeat,
            suspended,
            sheets.suspended.character.id,
            sheets.suspended.revision,
          ),
        ),
      ),
    ).toBe('ACCOUNT_INACTIVE');
    expect(await activeRows(sessionId)).toEqual([]);
  });

  it('releases on leave so the character is available again and an explicit re-bind succeeds', async () => {
    const owner = await makeAccount();
    const sessionId = await makeSession(owner);
    const firstSeat = await seat(sessionId, owner);
    const secondSeat = await seat(sessionId, owner);
    const sheet = await ownedCharacter(owner);

    const first = await repo.bind(
      bindInput(
        sessionId,
        firstSeat,
        owner,
        sheet.character.id,
        sheet.revision,
      ),
    );
    expect(await repo.release(sessionId, firstSeat, owner)).toBe(true);
    // A second release of the same seat is a no-op rather than an error.
    expect(await repo.release(sessionId, firstSeat, owner)).toBe(false);
    expect(
      (
        await db.query<{ binding_status: string }>(
          'SELECT binding_status FROM session_seat_characters WHERE id=$1',
          [first.bindingId],
        )
      ).rows[0]!.binding_status,
    ).toBe('released');

    // Availability is restored: the other seat of the same account can take the sheet.
    await repo.bind(
      bindInput(
        sessionId,
        secondSeat,
        owner,
        sheet.character.id,
        sheet.revision,
      ),
    );
    expect(
      await errorCodeOf(
        repo.bind(
          bindInput(
            sessionId,
            firstSeat,
            owner,
            sheet.character.id,
            sheet.revision,
          ),
        ),
      ),
    ).toBe('ALREADY_BOUND');

    await repo.release(sessionId, secondSeat, owner);
    const rebound = await repo.bind(
      bindInput(
        sessionId,
        firstSeat,
        owner,
        sheet.character.id,
        sheet.revision,
      ),
    );
    expect(rebound.bindingId).not.toBe(first.bindingId);
    expect(await activeRows(sessionId)).toMatchObject([
      { seat_id: firstSeat, character_id: sheet.character.id },
    ]);
  });

  it('removes an account link on deletion, keeps other seats bound, and replays the same ownership', async () => {
    const host = await makeAccount();
    const leaving = await makeAccount();
    const staying = await makeAccount();
    const sessionId = await makeSession(host);
    const leavingSeat = await seat(sessionId, leaving);
    const stayingSeat = await seat(sessionId, staying);
    const leavingSheet = await ownedCharacter(leaving);
    const stayingSheet = await ownedCharacter(staying);
    const leavingBinding = await repo.bind(
      bindInput(
        sessionId,
        leavingSeat,
        leaving,
        leavingSheet.character.id,
        leavingSheet.revision,
      ),
    );
    await repo.bind(
      bindInput(
        sessionId,
        stayingSeat,
        staying,
        stayingSheet.character.id,
        stayingSheet.revision,
      ),
    );

    const persistence = new Persistence(db);
    const beforeDeletion =
      await persistence.loadActiveSeatCharacterBindings(sessionId);
    expect(beforeDeletion.map((b) => b.seatId).sort()).toEqual(
      [leavingSeat, stayingSeat].sort(),
    );

    await db.query(
      "UPDATE accounts SET status='deleting',deletion_requested_at=now() WHERE id=$1",
      [leaving],
    );
    const result = await runAccountDeletions(
      { db, store: {} as never, now: new Date(), log: () => {} },
      [leaving],
    );
    expect(result).toMatchObject({ deleted: 1, failed: 0, held: 0 });

    // No account-character link survives for the deleted account.
    expect(
      (
        await db.query(
          'SELECT 1 FROM account_characters WHERE id=$1 OR account_id=$2',
          [leavingSheet.character.id, leaving],
        )
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await db.query(
          'SELECT binding_status,account_id,character_id FROM session_seat_characters WHERE id=$1',
          [leavingBinding.bindingId],
        )
      ).rows[0],
    ).toEqual({
      binding_status: 'redacted',
      account_id: null,
      character_id: null,
    });

    // Replay (from a fresh persistence instance) still reports the surviving seat's owner exactly.
    const afterDeletion = await new Persistence(
      db,
    ).loadActiveSeatCharacterBindings(sessionId);
    expect(afterDeletion).toEqual([
      expect.objectContaining({ seatId: stayingSeat, accountId: staying }),
    ]);
  });

  it('reloads identical seat-to-account ownership from the database after a restart', async () => {
    const owner = await makeAccount();
    const sessionId = await makeSession(owner);
    const seats = [];
    for (let i = 0; i < 3; i++) {
      const accountId = i === 0 ? owner : await makeAccount();
      const seatId = await seat(sessionId, accountId);
      const sheet = await ownedCharacter(accountId);
      await repo.bind(
        bindInput(
          sessionId,
          seatId,
          accountId,
          sheet.character.id,
          sheet.revision,
        ),
      );
      seats.push({ seatId, accountId });
    }

    const beforeRestart = await new Persistence(
      db,
    ).loadActiveSeatCharacterBindings(sessionId);
    // A brand-new pool stands in for a process restart.
    const restarted = new Pool({ connectionString: process.env.DATABASE_URL });
    try {
      const afterRestart = await new Persistence(
        restarted,
      ).loadActiveSeatCharacterBindings(sessionId);
      expect(afterRestart).toEqual(beforeRestart);
      expect(
        Object.fromEntries(afterRestart.map((b) => [b.seatId, b.accountId])),
      ).toEqual(Object.fromEntries(seats.map((s) => [s.seatId, s.accountId])));
    } finally {
      await restarted.end();
    }
  });

  it('leaves the owner binding unchanged after a rejected cross-seat bind (card 35780bbc)', async () => {
    const owner = await makeAccount();
    const guest = await makeAccount();
    const sessionId = await makeSession(owner);
    const ownerSeat = await seat(sessionId, owner);
    const guestSeat = await seat(sessionId, guest);
    const sheet = await ownedCharacter(owner);
    await repo.bind(
      bindInput(
        sessionId,
        ownerSeat,
        owner,
        sheet.character.id,
        sheet.revision,
      ),
    );
    const before = await db.query(
      'SELECT id,seat_id,account_id,character_id,character_revision,binding_status FROM session_seat_characters WHERE session_id=$1',
      [sessionId],
    );
    const eventsBefore = (
      await db.query(
        'SELECT count(*)::int AS n FROM events WHERE session_id=$1',
        [sessionId],
      )
    ).rows[0]!.n;

    expect(
      await errorCodeOf(
        repo.bind(
          bindInput(
            sessionId,
            guestSeat,
            guest,
            sheet.character.id,
            sheet.revision,
          ),
        ),
      ),
    ).toBe('NOT_OWNER');

    const after = await db.query(
      'SELECT id,seat_id,account_id,character_id,character_revision,binding_status FROM session_seat_characters WHERE session_id=$1',
      [sessionId],
    );
    expect(after.rows).toEqual(before.rows);
    expect(
      (
        await db.query(
          'SELECT count(*)::int AS n FROM events WHERE session_id=$1',
          [sessionId],
        )
      ).rows[0]!.n,
    ).toBe(eventsBefore);
  });
});
