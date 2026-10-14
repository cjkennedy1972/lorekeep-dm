import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { Persistence } from '../../src/persistence/index.js';

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

  it('reports no plan when no turn has resolved', () =>
    fixture(async (pool, id) => {
      const persistence = new Persistence(pool);
      await persistence.append(id, [
        row('pause', 'TablePaused', { paused: true }),
      ]);
      expect(await persistence.loadRewindPlan(id)).toBeNull();
    }));
});
