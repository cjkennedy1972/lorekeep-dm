import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { createSession } from '../../src/accounts/sessions.js';
import { Persistence } from '../../src/persistence/index.js';
import { RoomRegistry } from '../../src/room/registry.js';
import { SessionLease } from '../../src/room/lease.js';

const db = new Pool({ connectionString: process.env.DATABASE_URL });
const store = new Persistence(db);
const leases = new SessionLease(db);
const rooms = new RoomRegistry(store, leases, 'room-limits');
const app = createApp(db, {
  rooms,
  roomLimits: { maxRooms: 3, createPerHour: 5 },
});
const ids: string[] = [];
async function account() {
  const id = randomUUID();
  await db.query(
    `INSERT INTO accounts(id,email,password_hash,display_name,status,is_adult,age_checked_at,terms_version,terms_accepted_at) VALUES($1,$2,'x','P','active',true,now(),'v1',now())`,
    [id, `${id}@example.test`],
  );
  ids.push(id);
  return { id, cookie: `sid=${await createSession(db, id, 't')}` };
}
async function rawRoom(owner: string) {
  const id = randomUUID();
  await db.query('INSERT INTO sessions(id,owner_account_id) VALUES($1,$2)', [
    id,
    owner,
  ]);
  return id;
}
const create = (cookie: string) =>
  app.inject({
    method: 'POST',
    url: '/api/rooms',
    headers: { cookie },
    payload: { name: 'Table' },
  });
afterAll(async () => {
  await rooms.drain();
  await app.close();
  // events are append-only, so rows are left behind (random ids, as in the other db tests)
  await db.end();
});

describe('room quota, creation throttle and idle eviction', () => {
  it('refuses a 4th active room with 409 ROOM_LIMIT and a readable message', async () => {
    const u = await account();
    for (let i = 0; i < 3; i++)
      expect((await create(u.cookie)).statusCode).toBe(201);
    const res = await create(u.cookie);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'ROOM_LIMIT' });
    expect(res.json().message).toMatch(/at most 3 active tables/);
    // quota is per account
    expect((await create((await account()).cookie)).statusCode).toBe(201);
  });
  it('throttles creation per account with 429 even when rooms are deleted', async () => {
    const u = await account();
    for (let i = 0; i < 5; i++) {
      const res = await create(u.cookie);
      expect(res.statusCode).toBe(201);
      await db.query("UPDATE sessions SET status='closed' WHERE id=$1", [
        res.json().room.id,
      ]);
    }
    const res = await create(u.cookie);
    expect(res.statusCode).toBe(429);
    expect(res.json().code).toBe('RATE_LIMITED');
  });
  it('evicts idle rooms, releases the lease, and rehydrates on demand', async () => {
    const u = await account();
    const id = await rawRoom(u.id);
    const reg = new RoomRegistry(store, leases, 'evictor', 1000, 3_600_000);
    const room = await reg.get(id);
    await room.seat(randomUUID(), 'Guest');
    const { state, seq } = room;
    expect(await reg.evictIdle(Date.now())).toEqual([]); // not idle yet
    const evicted = await reg.evictIdle(Date.now() + 5000);
    expect(evicted).toEqual([id]);
    // lease released: another node can take it immediately
    const taken = await leases.acquire(id, 'other-node');
    expect(taken).not.toBeNull();
    await leases.release(taken!);
    const again = await reg.get(id);
    expect(again).not.toBe(room);
    expect(again.state).toEqual(state);
    expect(again.seq).toBe(seq);
    await reg.drain();
  });
  it('does not evict a room that has a connected socket', async () => {
    const u = await account();
    const id = await rawRoom(u.id);
    const reg = new RoomRegistry(store, leases, 'busy', 1000, 3_600_000);
    const room = await reg.get(id);
    await room.join(u.id, { send() {} }, 'P');
    expect(await reg.evictIdle(Date.now() + 5000)).toEqual([]);
    await room.disconnect(u.id);
    expect(await reg.evictIdle(Date.now() + 5000)).toEqual([id]);
    await reg.drain();
  });
});
