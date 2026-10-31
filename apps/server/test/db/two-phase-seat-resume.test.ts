import { randomUUID, createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  activateSeatResumeCandidate,
  beginSeatResumeCandidate,
} from '../../src/gateway/resumeTokens.js';
import { createTestDatabase, type TestDatabase } from './testDb.js';

const databaseUrl = process.env.DATABASE_URL;
let database: TestDatabase | undefined;
const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');

describe.skipIf(!databaseUrl)('two-phase seat resume storage', () => {
  beforeAll(async () => {
    database = await createTestDatabase();
    await database.pool.query(`
      CREATE TABLE sessions (id uuid PRIMARY KEY);
      CREATE TABLE seat_resume_tokens (
        session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        seat_id uuid NOT NULL,
        token_hash text NOT NULL,
        rotated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        active_socket_id uuid,
        heartbeat_at timestamptz,
        PRIMARY KEY(session_id, seat_id),
        CHECK ((active_socket_id IS NULL) = (heartbeat_at IS NULL))
      );`);
    const { readFile } = await import('node:fs/promises');
    await database.pool.query(
      await readFile(
        new URL(
          '../../migrations/0055_two_phase_seat_resume.sql',
          import.meta.url,
        ),
        'utf8',
      ),
    );
  });
  afterAll(async () => database?.close());

  async function seat() {
    const sessionId = randomUUID();
    const seatId = randomUUID();
    const socketId = randomUUID();
    await database!.pool.query('INSERT INTO sessions(id) VALUES ($1)', [
      sessionId,
    ]);
    await database!.pool.query(
      `INSERT INTO seat_resume_tokens(session_id,seat_id,token_hash,active_socket_id,heartbeat_at)
       VALUES($1,$2,$3,$4,clock_timestamp())`,
      [sessionId, seatId, hash('active'), socketId],
    );
    return { sessionId, seatId, socketId };
  }

  it('stores only the candidate hash and activates with an idempotency marker using CAS', async () => {
    const { sessionId, seatId, socketId } = await seat();
    const pending = await beginSeatResumeCandidate(
      database!.pool,
      sessionId,
      seatId,
      socketId,
    );
    expect(pending.status).toBe('started');
    if (pending.status !== 'started') return;
    const row = await database!.pool.query(
      'SELECT token_hash,pending_token_hash,pending_rotation_id,last_activated_rotation_id FROM seat_resume_tokens WHERE session_id=$1 AND seat_id=$2',
      [sessionId, seatId],
    );
    expect(row.rows[0]).toMatchObject({
      token_hash: hash('active'),
      pending_token_hash: hash(pending.candidate),
      pending_rotation_id: pending.rotationId,
      last_activated_rotation_id: null,
    });
    expect(JSON.stringify(row.rows[0])).not.toContain(pending.candidate);
    expect(
      await activateSeatResumeCandidate(
        database!.pool,
        sessionId,
        seatId,
        socketId,
        pending.rotationId,
        'wrong-candidate',
      ),
    ).toBe(false);
    expect(
      await activateSeatResumeCandidate(
        database!.pool,
        sessionId,
        seatId,
        socketId,
        pending.rotationId,
        pending.candidate,
      ),
    ).toBe(true);
    expect(
      await activateSeatResumeCandidate(
        database!.pool,
        sessionId,
        seatId,
        socketId,
        pending.rotationId,
        pending.candidate,
      ),
    ).toBe(false);
    const activated = await database!.pool.query(
      'SELECT token_hash,pending_rotation_id,last_activated_rotation_id,last_activated_socket_id FROM seat_resume_tokens WHERE session_id=$1 AND seat_id=$2',
      [sessionId, seatId],
    );
    expect(activated.rows[0]).toMatchObject({
      token_hash: hash(pending.candidate),
      pending_rotation_id: null,
      last_activated_rotation_id: pending.rotationId,
      last_activated_socket_id: socketId,
    });
    const refunded = await database!.pool.query(
      'SELECT rotation_window_started_at,rotation_starts_in_window FROM seat_resume_tokens WHERE session_id=$1 AND seat_id=$2',
      [sessionId, seatId],
    );
    expect(refunded.rows[0]).toEqual({
      rotation_window_started_at: null,
      rotation_starts_in_window: 0,
    });
  });

  it('enforces pending tuple and bounded rate-counter constraints in the schema', async () => {
    const { sessionId, seatId } = await seat();
    await expect(
      database!.pool.query(
        'UPDATE seat_resume_tokens SET pending_token_hash=$3 WHERE session_id=$1 AND seat_id=$2',
        [sessionId, seatId, hash('orphan')],
      ),
    ).rejects.toThrow(/seat_resume_pending_tuple/);
    await expect(
      database!.pool.query(
        'UPDATE seat_resume_tokens SET rotation_starts_in_window=7 WHERE session_id=$1 AND seat_id=$2',
        [sessionId, seatId],
      ),
    ).rejects.toThrow(/seat_resume_rotation_starts_cap/);
  });

  it('caps non-activated ordinary starts at six and keeps the active hash authenticating', async () => {
    const { sessionId, seatId, socketId } = await seat();
    for (let i = 0; i < 6; i++) {
      const started = await beginSeatResumeCandidate(
        database!.pool,
        sessionId,
        seatId,
        socketId,
      );
      expect(started.status).toBe('started');
      if (started.status !== 'started') break;
      await database!.pool.query(
        "UPDATE seat_resume_tokens SET pending_expires_at=clock_timestamp()-interval '1 second' WHERE session_id=$1 AND seat_id=$2",
        [sessionId, seatId],
      );
    }
    expect(
      (
        await beginSeatResumeCandidate(
          database!.pool,
          sessionId,
          seatId,
          socketId,
        )
      ).status,
    ).toBe('rate-limited');
    const row = await database!.pool.query(
      'SELECT token_hash,rotation_starts_in_window FROM seat_resume_tokens WHERE session_id=$1 AND seat_id=$2',
      [sessionId, seatId],
    );
    expect(row.rows[0]).toEqual({
      token_hash: hash('active'),
      rotation_starts_in_window: 6,
    });
    const recovery = await beginSeatResumeCandidate(
      database!.pool,
      sessionId,
      seatId,
      socketId,
      true,
    );
    expect(recovery.status).toBe('started');
    if (recovery.status === 'started') {
      expect(
        await activateSeatResumeCandidate(
          database!.pool,
          sessionId,
          seatId,
          socketId,
          recovery.rotationId,
          recovery.candidate,
          true,
        ),
      ).toBe(true);
    }
    const afterRecovery = await database!.pool.query(
      'SELECT token_hash,rotation_starts_in_window FROM seat_resume_tokens WHERE session_id=$1 AND seat_id=$2',
      [sessionId, seatId],
    );
    expect(afterRecovery.rows[0]).toEqual({
      token_hash: hash(recovery.candidate),
      rotation_starts_in_window: 6,
    });
  });
});
