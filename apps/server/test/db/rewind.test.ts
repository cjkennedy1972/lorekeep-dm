import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import {
  LeaseConflictError,
  Persistence,
} from '../../src/persistence/index.js';
import { REVERTED_TURN_EXCLUSION } from '../../src/persistence/rewind.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl)
  throw new Error('DATABASE_URL required for rewind integration tests');

async function fixture(run: (pool: Pool, sessionId: string) => Promise<void>) {
  const pool = new Pool({ connectionString: databaseUrl });
  const sessionId = randomUUID();
  try {
    await pool.query(
      'INSERT INTO accounts(id,email,password_hash,display_name,is_adult,age_checked_at,terms_version,terms_accepted_at) VALUES ($1,$2,$3,$4,true,now(),$5,now())',
      [sessionId, `${sessionId}@example.test`, 'hash', 'Player', 'v1'],
    );
    await pool.query(
      'INSERT INTO sessions(id,owner_account_id) VALUES ($1,$1)',
      [sessionId],
    );
    await run(pool, sessionId);
  } finally {
    await pool.end();
  }
}

const ids = {
  a: randomUUID(),
  b: randomUUID(),
  pause: randomUUID(),
  r: randomUUID(),
} as const;
const row = (
  turnId: keyof typeof ids,
  type: string,
  payload: unknown = {},
) => ({
  turnId: ids[turnId],
  type,
  payload,
});

describe('rewind plan', () => {
  it('targets the last resolved turn, its pre-turn snapshot, and the rewind it used', () =>
    fixture(async (pool, id) => {
      const persistence = new Persistence(pool);
      await persistence.writeTurn(id, [row('a', 'NarrationCompleted')], {
        turn: 1,
      });
      await persistence.append(id, [
        row('pause', 'TablePaused', { paused: true }),
      ]);
      await persistence.writeTurn(
        id,
        [row('b', 'ToolCall'), row('b', 'NarrationCompleted')],
        { turn: 2 },
      );

      const plan = await persistence.loadRewindPlan(id);
      expect(plan).toMatchObject({ turnId: ids.b, rewindUsed: false });
      expect(plan!.before.snapshot).toMatchObject({
        seq: 1,
        state: { turn: 1 },
      });
      expect(plan!.before.events.map((event) => event.seq)).toEqual([2]);

      await persistence.writeTurn(
        id,
        [
          row('r', 'TurnReverted', {
            type: 'TurnReverted',
            turnId: ids.r,
            revertedTurnId: ids.b,
          }),
        ],
        { turn: 1 },
      );
      expect(await persistence.loadRewindPlan(id)).toMatchObject({
        turnId: ids.a,
        rewindUsed: true,
      });
    }));

  it('retains room-level events logged after the reverted turn began', () =>
    fixture(async (pool, id) => {
      const persistence = new Persistence(pool);
      await persistence.writeTurn(id, [row('a', 'NarrationCompleted')], {
        turn: 1,
      });
      await persistence.writeTurn(
        id,
        [row('b', 'ToolCall'), row('b', 'NarrationCompleted')],
        { turn: 2 },
      );
      await persistence.append(id, [
        row('pause', 'TablePaused', { paused: true }),
      ]);

      const plan = await persistence.loadRewindPlan(id);
      expect(plan!.before.events).toEqual([]);
      expect(plan!.retained.map((event) => event.type)).toEqual([
        'TablePaused',
      ]);
      expect(plan!.headSeq).toBe(4);
    }));

  it('refuses a rewind planned against a log head that has since moved', () =>
    fixture(async (pool, id) => {
      const persistence = new Persistence(pool);
      await persistence.writeTurn(id, [row('a', 'NarrationCompleted')], {
        turn: 1,
      });
      await persistence.writeTurn(id, [row('b', 'NarrationCompleted')], {
        turn: 2,
      });
      const plan = await persistence.loadRewindPlan(id);
      await persistence.append(id, [
        row('pause', 'TablePaused', { paused: true }),
      ]);

      await expect(
        persistence.writeTurn(
          id,
          [
            row('r', 'TurnReverted', {
              type: 'TurnReverted',
              turnId: ids.r,
              revertedTurnId: ids.b,
            }),
          ],
          { turn: 1 },
          undefined,
          [],
          plan!.headSeq,
        ),
      ).rejects.toThrow(LeaseConflictError);
      expect(await persistence.loadRewindPlan(id)).toMatchObject({
        turnId: ids.b,
      });
    }));

  it('hides events of reverted turns from raw log reads', () =>
    fixture(async (pool, id) => {
      const persistence = new Persistence(pool);
      await persistence.writeTurn(id, [row('a', 'NarrationCompleted')], {
        turn: 1,
      });
      await persistence.writeTurn(id, [row('b', 'NarrationCompleted')], {
        turn: 2,
      });
      await persistence.writeTurn(
        id,
        [
          row('r', 'TurnReverted', {
            type: 'TurnReverted',
            turnId: ids.r,
            revertedTurnId: ids.b,
          }),
        ],
        { turn: 1 },
      );
      const { rows } = await pool.query<{ turn_id: string }>(
        `SELECT turn_id::text AS turn_id FROM events WHERE session_id = $1 AND ${REVERTED_TURN_EXCLUSION} ORDER BY seq`,
        [id],
      );
      expect(rows.map((row) => row.turn_id)).not.toContain(ids.b);
      expect(rows.map((row) => row.turn_id)).toContain(ids.a);
    }));

  it('fences turn writes to the live lease holder', () =>
    fixture(async (pool, id) => {
      const persistence = new Persistence(pool);
      await pool.query(
        `INSERT INTO session_lease(session_id,node_id,expires_at,epoch)
         VALUES ($1,'node-b',now() + interval '1 minute',2)`,
        [id],
      );
      const write = (lease?: { nodeId: string; epoch: number }) =>
        persistence.writeTurn(id, [row('a', 'NarrationCompleted')], {}, lease);

      await expect(write({ nodeId: 'node-a', epoch: 1 })).rejects.toThrow(
        LeaseConflictError,
      );
      await expect(write()).rejects.toThrow(LeaseConflictError);
      await pool.query(
        `UPDATE session_lease SET expires_at = now() - interval '1 second' WHERE session_id = $1`,
        [id],
      );
      await expect(write({ nodeId: 'node-b', epoch: 2 })).rejects.toThrow(
        LeaseConflictError,
      );
      const { rows } = await pool.query(
        'SELECT 1 FROM events WHERE session_id = $1',
        [id],
      );
      expect(rows).toHaveLength(0);
    }));

  it('reports no plan when no turn has resolved', () =>
    fixture(async (pool, id) => {
      const persistence = new Persistence(pool);
      await persistence.append(id, [
        row('pause', 'TablePaused', { paused: true }),
      ]);
      expect(await persistence.loadRewindPlan(id)).toBeNull();
    }));
});
