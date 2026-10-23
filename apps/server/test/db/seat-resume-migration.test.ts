import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from './testDb.js';

const databaseUrl = process.env.DATABASE_URL;
let database: TestDatabase | undefined;

describe.skipIf(!databaseUrl)(
  'seat resume token initialization migration',
  () => {
    beforeAll(async () => {
      database = await createTestDatabase();
      await database.pool.query(
        `CREATE TABLE sessions (id uuid PRIMARY KEY);
       CREATE TABLE events (
         session_id uuid NOT NULL REFERENCES sessions(id),
         seq bigint NOT NULL,
         type text NOT NULL,
         payload jsonb NOT NULL,
         PRIMARY KEY(session_id, seq)
       );
       CREATE TABLE seat_resume_tokens (
         session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
         seat_id uuid NOT NULL,
         token_hash text NOT NULL,
         rotated_at timestamptz NOT NULL DEFAULT now(),
         active_socket_id uuid,
         heartbeat_at timestamptz,
         PRIMARY KEY(session_id, seat_id),
         CHECK ((active_socket_id IS NULL) = (heartbeat_at IS NULL))
       );`,
      );
    });

    afterAll(async () => database?.close());

    it('backfills current seats, skips revoked and malformed history, and initializes new joins', async () => {
      const sessionId = randomUUID();
      const activeSeatId = randomUUID();
      const revokedSeatId = randomUUID();
      await database!.pool.query('INSERT INTO sessions(id) VALUES ($1)', [
        sessionId,
      ]);
      await database!.pool.query(
        `INSERT INTO events(session_id,seq,type,payload) VALUES
       ($1,1,'SeatJoined',$2::jsonb),
       ($1,2,'SeatJoined',$3::jsonb),
       ($1,3,'SeatRevoked',$4::jsonb),
       ($1,4,'SeatJoined',$5::jsonb)`,
        [
          sessionId,
          JSON.stringify({ seatId: activeSeatId }),
          JSON.stringify({ seatId: revokedSeatId }),
          JSON.stringify({ seatId: revokedSeatId }),
          JSON.stringify({ legacy: true }),
        ],
      );
      await database!.pool.query(
        await readFile(
          new URL(
            '../../migrations/0039_initialize_seat_resume_tokens.sql',
            import.meta.url,
          ),
          'utf8',
        ),
      );

      const backfilled = await database!.pool.query<{ seat_id: string }>(
        'SELECT seat_id FROM seat_resume_tokens WHERE session_id=$1 ORDER BY seat_id',
        [sessionId],
      );
      expect(backfilled.rows.map((row) => row.seat_id)).toEqual([activeSeatId]);
      expect(backfilled.rows[0]?.seat_id).toBe(activeSeatId);

      const newlyJoinedSeatId = randomUUID();
      await database!.pool.query(
        `INSERT INTO events(session_id,seq,type,payload)
       VALUES ($1,5,'SeatJoined',$2::jsonb)`,
        [sessionId, JSON.stringify({ seatId: newlyJoinedSeatId })],
      );
      const initialized = await database!.pool.query(
        'SELECT 1 FROM seat_resume_tokens WHERE session_id=$1 AND seat_id=$2',
        [sessionId, newlyJoinedSeatId],
      );
      expect(initialized.rowCount).toBe(1);
    });
  },
);
