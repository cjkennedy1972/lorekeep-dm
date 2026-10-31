import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  advanceSeatStream,
  initializeSeatStream,
  loadSeatStream,
  reinitializeSeatStream,
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

describe('seat stream persistence', () => {
  let database: TestDatabase;
  let sessionId: string;
  const seatId = randomUUID();
  beforeEach(async () => {
    database = await createTestDatabase();
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
  });
  afterEach(async () => database.close());

  it('creates a durable initial stream with an independent 128-bit generation nonce', async () => {
    const client = await database.pool.connect();
    try {
      const stream = await initializeSeatStream(client, sessionId, seatId);
      expect(stream).toMatchObject({
        sessionId,
        seatId,
        bindingEpoch: 1,
        cursor: 0,
      });
      expect(stream.generation).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(await loadSeatStream(client, sessionId, seatId)).toEqual(stream);
      expect(await initializeSeatStream(client, sessionId, seatId)).toEqual(
        stream,
      );
    } finally {
      client.release();
    }
  });

  it('advances only the matching generation and recovers at the same binding epoch with a fresh nonce', async () => {
    const client = await database.pool.connect();
    try {
      const before = await initializeSeatStream(client, sessionId, seatId);
      expect(await advanceSeatStream(client, before, 3)).toBe(3);
      const reset = await reinitializeSeatStream(
        client,
        sessionId,
        seatId,
        before.bindingEpoch,
      );
      expect(reset).toMatchObject({ bindingEpoch: 1, cursor: 0 });
      expect(reset.generation).not.toBe(before.generation);
      await expect(advanceSeatStream(client, before)).rejects.toThrow(
        'seat_stream_generation_changed',
      );
      expect(await advanceSeatStream(client, reset)).toBe(1);
    } finally {
      client.release();
    }
  });
});
