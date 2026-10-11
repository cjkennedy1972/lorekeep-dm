import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadSeatedMatureOptOuts } from '../../src/safety/tierLoader.js';
import { createTestDatabase, type TestDatabase } from './testDb.js';

async function applyMigrations(database: TestDatabase) {
  const files = await readdir(new URL('../../migrations/', import.meta.url));
  const names = [...new Set(files.filter((f) => f.endsWith('.sql')))].sort();
  for (const name of names)
    await database.pool.query(
      await readFile(
        new URL(`../../migrations/${name}`, import.meta.url),
        'utf8',
      ),
    );
}

async function account(database: TestDatabase, matureOptOut: boolean) {
  const id = randomUUID();
  await database.pool.query(
    `INSERT INTO accounts(id,email,password_hash,display_name,is_adult,age_checked_at,terms_version,terms_accepted_at,mature_opt_out)
     VALUES ($1,$2,'hash','Player',true,now(),'v1',now(),$3)`,
    [id, `${id}@example.test`, matureOptOut],
  );
  return id;
}

async function seatJoined(
  database: TestDatabase,
  sessionId: string,
  seq: number,
  accountId: string,
  seatSnapshotOptOut: boolean,
) {
  await database.pool.query(
    'INSERT INTO events(session_id,seq,turn_id,type,payload) VALUES($1,$2,$1,$3,$4)',
    [
      sessionId,
      seq,
      'SeatJoined',
      {
        seatId: randomUUID(),
        accountId,
        displayName: 'Seat',
        presence: 'offline',
        matureOptOut: seatSnapshotOptOut,
      },
    ],
  );
}

describe('loadSeatedMatureOptOuts', () => {
  let database: TestDatabase;
  let sessionId: string;

  beforeEach(async () => {
    database = await createTestDatabase({ extraSearchPath: ['public'] });
    await applyMigrations(database);
    sessionId = randomUUID();
    const owner = await account(database, false);
    await database.pool.query(
      'INSERT INTO sessions(id,owner_account_id) VALUES ($1,$2)',
      [sessionId, owner],
    );
  });

  afterEach(async () => {
    await database.close();
  });

  it('returns the live account value, not the seat join-time snapshot', async () => {
    const joinedOptedIn = await account(database, false);
    const joinedOptedOut = await account(database, true);
    await seatJoined(database, sessionId, 1, joinedOptedIn, false);
    await seatJoined(database, sessionId, 2, joinedOptedOut, false);
    await database.pool.query(
      'UPDATE accounts SET mature_opt_out=true WHERE id=$1',
      [joinedOptedIn],
    );
    await database.pool.query(
      'UPDATE accounts SET mature_opt_out=false WHERE id=$1',
      [joinedOptedOut],
    );

    const optOuts = await loadSeatedMatureOptOuts(database.pool, sessionId);

    expect([...optOuts].sort()).toEqual([false, true]);
  });

  it('counts a seated account whose row is gone as opted out', async () => {
    await seatJoined(database, sessionId, 1, randomUUID(), false);

    expect(await loadSeatedMatureOptOuts(database.pool, sessionId)).toEqual([
      true,
    ]);
  });

  it('returns one entry per distinct seated account and none for an empty table', async () => {
    const seated = await account(database, false);
    await seatJoined(database, sessionId, 1, seated, false);
    await seatJoined(database, sessionId, 2, seated, false);

    expect(await loadSeatedMatureOptOuts(database.pool, sessionId)).toEqual([
      false,
    ]);
    expect(await loadSeatedMatureOptOuts(database.pool, randomUUID())).toEqual(
      [],
    );
  });
});
