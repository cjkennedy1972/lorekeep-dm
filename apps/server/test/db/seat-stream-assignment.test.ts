import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Persistence } from '../../src/persistence/index.js';
import {
  initializeSeatStream,
  loadSeatStream,
} from '../../src/persistence/seatStreams.js';
import { createTestDatabase, type TestDatabase } from './testDb.js';

async function migrate(database: TestDatabase) {
  const names = (await readdir(new URL('../../migrations/', import.meta.url)))
    .filter((file) => file.endsWith('.sql'))
    .sort();
  for (const name of names)
    await database.pool.query(
      await readFile(
        new URL(`../../migrations/${name}`, import.meta.url),
        'utf8',
      ),
    );
}

describe('transactional per-seat cursor assignment', () => {
  let database: TestDatabase;
  let sessionId: string;
  let persistence: Persistence;
  const seatA = randomUUID();
  const seatB = randomUUID();
  beforeEach(async () => {
    database = await createTestDatabase({ extraSearchPath: ['public'] });
    await migrate(database);
    sessionId = randomUUID();
    const ownerId = randomUUID();
    await database.pool.query(
      "INSERT INTO accounts(id,email,password_hash,display_name,status,is_adult,age_checked_at,terms_version,terms_accepted_at) VALUES($1,$2,'x','Owner','active',true,now(),'v1',now())",
      [ownerId, `${ownerId}@example.test`],
    );
    await database.pool.query(
      'INSERT INTO sessions(id,owner_account_id) VALUES($1,$2)',
      [sessionId, ownerId],
    );
    persistence = new Persistence(database.pool);
  });
  afterEach(async () => database.close());

  it('advances monotonically only for the seats in the visible recipient plan', async () => {
    const client = await database.pool.connect();
    let a;
    let b;
    try {
      a = await initializeSeatStream(client, sessionId, seatA);
      b = await initializeSeatStream(client, sessionId, seatB);
    } finally {
      client.release();
    }
    const events = [
      { turnId: randomUUID(), type: 'VisibleUpdate', payload: {} },
    ];
    const first = await persistence.appendWithSeatCursors(sessionId, events, [
      {
        seatId: seatA,
        bindingEpoch: a.bindingEpoch,
        generation: a.generation,
        updates: 1,
      },
    ]);
    expect(first.cursors).toEqual([{ seatId: seatA, cursor: 1 }]);
    const second = await persistence.appendWithSeatCursors(sessionId, events, [
      {
        seatId: seatA,
        bindingEpoch: a.bindingEpoch,
        generation: a.generation,
        updates: 2,
      },
    ]);
    expect(second.cursors).toEqual([{ seatId: seatA, cursor: 3 }]);
    const afterA = await database.pool.query(
      'SELECT cursor FROM seat_streams WHERE session_id=$1 AND seat_id=$2',
      [sessionId, seatA],
    );
    const afterB = await database.pool.query(
      'SELECT cursor FROM seat_streams WHERE session_id=$1 AND seat_id=$2',
      [sessionId, seatB],
    );
    expect(afterA.rows[0].cursor).toBe('3');
    expect(afterB.rows[0].cursor).toBe('0');
    expect(b.cursor).toBe(0);
  });

  it('rolls back event append and earlier cursor updates when any planned stream is stale', async () => {
    const client = await database.pool.connect();
    let a;
    let b;
    try {
      a = await initializeSeatStream(client, sessionId, seatA);
      b = await initializeSeatStream(client, sessionId, seatB);
    } finally {
      client.release();
    }
    await expect(
      persistence.appendWithSeatCursors(
        sessionId,
        [{ turnId: randomUUID(), type: 'VisibleUpdate', payload: {} }],
        [
          {
            seatId: seatA,
            bindingEpoch: a.bindingEpoch,
            generation: a.generation,
            updates: 1,
          },
          {
            seatId: seatB,
            bindingEpoch: b.bindingEpoch,
            generation: 'AAAAAAAAAAAAAAAAAAAAAA',
            updates: 1,
          },
        ],
      ),
    ).rejects.toThrow('seat_stream_generation_changed');
    const verify = await database.pool.connect();
    try {
      expect(await loadSeatStream(verify, sessionId, seatA)).toMatchObject({
        cursor: 0,
      });
    } finally {
      verify.release();
    }
    const events = await database.pool.query(
      'SELECT count(*)::text AS count FROM events WHERE session_id=$1',
      [sessionId],
    );
    expect(events.rows[0].count).toBe('0');
  });
});
