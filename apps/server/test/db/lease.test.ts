import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { Persistence } from '../../src/persistence/index.js';
import { SessionLease } from '../../src/room/lease.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl)
  throw new Error('DATABASE_URL required for lease integration tests');

async function fixture(run: (pool: Pool, id: string) => Promise<void>) {
  const pool = new Pool({ connectionString: databaseUrl });
  const id = randomUUID();
  try {
    await pool.query(
      'INSERT INTO accounts(id,email,password_hash,display_name,is_adult,age_checked_at,terms_version,terms_accepted_at) VALUES ($1,$2,$3,$4,true,now(),$5,now())',
      [id, `${id}@example.test`, 'hash', 'Player', 'v1'],
    );
    await pool.query(
      'INSERT INTO sessions(id,owner_account_id) VALUES ($1,$1)',
      [id],
    );
    await run(pool, id);
  } finally {
    await pool.end();
  }
}

const event = () => ({ turnId: randomUUID(), type: 'Turn', payload: {} });

describe('session lease', () => {
  it('excludes a second node and rejects non-holder renewals', async () =>
    fixture(async (pool, id) => {
      const leases = new SessionLease(pool, {
        ttlMs: 1000,
        heartbeatIntervalMs: 100,
      });
      const first = await leases.acquire(id, 'a');
      expect(first).not.toBeNull();
      if (!first) return;
      expect(await leases.acquire(id, 'b')).toBeNull();
      expect(await leases.renew({ ...first, nodeId: 'b' })).toBeNull();
      expect(await leases.renew(first)).not.toBeNull();
      expect(await leases.release(first)).toBe(true);
      const second = await leases.acquire(id, 'b');
      expect(second?.epoch).toBe(first.epoch + 1);
      expect(await leases.release(first)).toBe(false);
    }));

  it('takes over after expiry and fences stale appends, including racing writers', async () =>
    fixture(async (pool, id) => {
      const leases = new SessionLease(pool, {
        ttlMs: 80,
        heartbeatIntervalMs: 10,
      });
      const persistence = new Persistence(pool);
      const first = await leases.acquire(id, 'a');
      expect(first).not.toBeNull();
      if (!first) return;
      await persistence.append(id, [event()], first);
      await new Promise((resolve) => setTimeout(resolve, 110));
      // The new holder gets a long TTL: append also checks the lease is live, and
      // with the 80ms TTL a slow CI runner could expire it before the racing write.
      const second = await new SessionLease(pool, {
        ttlMs: 30_000,
        heartbeatIntervalMs: 10_000,
      }).acquire(id, 'b');
      expect(second?.epoch).toBe(first.epoch + 1);
      if (!second) return;
      await expect(persistence.append(id, [event()], first)).rejects.toThrow(
        /fencing/,
      );
      await expect(persistence.append(id, [event()])).rejects.toThrow(
        /fencing/,
      );
      const writes = await Promise.allSettled([
        persistence.append(id, [event()], first),
        persistence.append(id, [event()], second),
      ]);
      expect(writes.map((result) => result.status)).toEqual([
        'rejected',
        'fulfilled',
      ]);
      expect(
        (await persistence.loadLatest(id)).events.map((item) => item.seq),
      ).toEqual([1, 2]);
    }));
});
