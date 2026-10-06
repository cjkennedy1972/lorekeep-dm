import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { Persistence } from '../../src/persistence/index.js';
import { RoomRegistry } from '../../src/room/registry.js';
import { SessionLease } from '../../src/room/lease.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL required');

describe('persisted room', () => {
  it('fences writes, rehydrates state, and releases lease on drain', async () => {
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
      const leases = new SessionLease(pool);
      const store = new Persistence(pool);
      const first = new RoomRegistry(store, leases, 'first');
      const room = await first.get(sessionId);
      const accountId = randomUUID();
      await room.join(accountId, { send() {} });
      const actionId = randomUUID();
      expect(await room.submit(actionId)).toBe(true);
      const original = room.state;
      const seq = room.seq;
      await first.drain();
      const second = new RoomRegistry(store, leases, 'second');
      const recovered = await second.get(sessionId);
      expect(recovered.state).toEqual(original);
      expect(recovered.seq).toBe(seq);
      expect(await recovered.submit(actionId)).toBe(false);
      const messages: unknown[] = [];
      await recovered.subscribe(
        accountId,
        {
          send(message) {
            messages.push(message);
          },
        },
        0,
      );
      expect(messages).toMatchObject([{ type: 'StateSync', seq }]);
      await second.drain();
      expect(await leases.acquire(sessionId, 'third')).not.toBeNull();
    } finally {
      await pool.end();
    }
  });
});
