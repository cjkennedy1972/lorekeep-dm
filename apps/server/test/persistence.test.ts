import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { Persistence } from '../src/persistence/index.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl)
  throw new Error('DATABASE_URL required for persistence integration tests');

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

const event = () => ({
  turnId: randomUUID(),
  type: 'Turn',
  payload: { ok: true },
});

describe('persistence', () => {
  it('serializes racing writers without gaps or duplicates', async () =>
    fixture(async (pool, id) => {
      const persistence = new Persistence(pool);
      const batches = await Promise.all(
        Array.from({ length: 12 }, () =>
          persistence.append(id, [event(), event()]),
        ),
      );
      expect(
        batches
          .flat()
          .map((item) => item.seq)
          .sort((a, b) => a - b),
      ).toEqual(Array.from({ length: 24 }, (_, index) => index + 1));
      await expect(
        persistence.append(id, [{ ...event(), seq: 26 }]),
      ).rejects.toThrow(/Non-contiguous/);
      expect((await persistence.loadLatest(id)).events).toHaveLength(24);
    }));

  it('loads the latest snapshot and ordered tail', async () =>
    fixture(async (pool, id) => {
      const persistence = new Persistence(pool);
      await persistence.append(id, [event()]);
      await persistence.writeTurn(id, [event(), event()], { turn: 1 });
      await persistence.append(id, [event(), event()]);
      const latest = await persistence.loadLatest(id);
      expect(latest.snapshot?.seq).toBe(3);
      expect(latest.snapshot?.state).toEqual({ turn: 1 });
      expect(latest.events.map((item) => item.seq)).toEqual([4, 5]);
    }));

  it('rolls back events when snapshot insertion fails', async () =>
    fixture(async (pool, id) => {
      const persistence = new Persistence(pool);
      await persistence.writeTurn(id, [event()], { turn: 1 });
      await pool.query(
        `CREATE OR REPLACE FUNCTION fail_snapshot_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'snapshot failed'; END $$`,
      );
      await pool.query(
        'CREATE TRIGGER fail_snapshot_test BEFORE INSERT ON snapshots FOR EACH ROW EXECUTE FUNCTION fail_snapshot_test()',
      );
      try {
        await expect(
          persistence.writeTurn(id, [event()], { turn: 2 }),
        ).rejects.toThrow(/snapshot failed/);
        expect(
          (
            await pool.query(
              'SELECT count(*)::int AS n FROM events WHERE session_id=$1',
              [id],
            )
          ).rows[0]?.n,
        ).toBe(1);
        expect(
          (
            await pool.query(
              'SELECT count(*)::int AS n FROM snapshots WHERE session_id=$1',
              [id],
            )
          ).rows[0]?.n,
        ).toBe(1);
      } finally {
        await pool.query('DROP TRIGGER fail_snapshot_test ON snapshots');
        await pool.query('DROP FUNCTION fail_snapshot_test()');
      }
    }));
});
