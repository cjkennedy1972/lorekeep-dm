import { allowInputGate } from '../support/allowInputGate.js';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { createSession } from '../../src/accounts/sessions.js';
import { Persistence } from '../../src/persistence/index.js';
import { RoomRegistry } from '../../src/room/registry.js';
import { SessionLease } from '../../src/room/lease.js';
import { installGateway } from '../../src/gateway/ws.js';

const db = new Pool({ connectionString: process.env.DATABASE_URL });
const rooms = new RoomRegistry(
  new Persistence(db),
  new SessionLease(db),
  'rooms-test',
);
const app = createApp(
  db,
  { inputGate: allowInputGate, rooms, joinRateLimit: 100 },
  { inputGate: allowInputGate },
);
installGateway(app, db, rooms);
const created: string[] = [];
async function account(status = 'active') {
  const id = randomUUID();
  await db.query(
    `INSERT INTO accounts(id,email,password_hash,display_name,status,is_adult,age_checked_at,terms_version,terms_accepted_at)
     VALUES($1,$2,'x',$3,$4,true,now(),'t',now())`,
    [id, `${id}@example.test`, `P-${id.slice(0, 4)}`, status],
  );
  created.push(id);
  return { id, cookie: `sid=${await createSession(db, id, 'test')}` };
}
const call = (
  who: { cookie: string },
  method: 'POST' | 'GET' | 'DELETE',
  url: string,
  payload?: object,
) =>
  app.inject({
    method,
    url,
    headers: { cookie: who.cookie },
    ...(payload ? { payload } : {}),
  });
afterAll(async () => {
  await rooms.drain();
  await app.close();
  // events are append-only, so rows are left behind (random ids, as in the other db tests)
  await db.end();
});

describe('rooms + invites (postgres)', () => {
  it('host room fetch omits the invite code and the database stores only its hash', async () => {
    const host = await account();
    const made = await call(host, 'POST', '/api/rooms', {
      name: 'Private Code',
    });
    expect(made.statusCode).toBe(201);
    const created = made.json().room;
    const fetched = await call(host, 'GET', `/api/rooms/${created.id}`);
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json().room).toMatchObject({ id: created.id, isHost: true });
    expect(fetched.json().room).not.toHaveProperty('code');

    const stored = await db.query(
      'SELECT to_jsonb(s) AS row FROM sessions s WHERE id=$1',
      [created.id],
    );
    expect(stored.rows[0].row.invite_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.rows[0].row.invite_hash).not.toBe(created.code);
    expect(stored.rows[0].row).not.toHaveProperty('code');
  });
  it('create/list, hashed invite, regenerate + revoke, idempotent join', async () => {
    const host = await account();
    const guest = await account();
    const made = await call(host, 'POST', '/api/rooms', { name: 'Table A' });
    expect(made.statusCode).toBe(201);
    const room = made.json().room;
    expect(room).toMatchObject({ name: 'Table A', isHost: true });
    const list = (await call(host, 'GET', '/api/rooms')).json().rooms;
    expect(list.map((r: { id: string }) => r.id)).toContain(room.id);
    expect(list[0].code).toBeUndefined();
    // only the hash is stored
    const row = (
      await db.query('SELECT invite_hash FROM sessions WHERE id=$1', [room.id])
    ).rows[0];
    expect(row.invite_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.invite_hash).not.toBe(room.code);
    // join: seated with the real SeatJoined payload
    const j1 = await call(guest, 'POST', `/api/invites/${room.code}/join`);
    expect(j1.statusCode).toBe(200);
    expect(j1.json().room).toMatchObject({ id: room.id, isHost: false });
    const j2 = await call(guest, 'POST', `/api/join/${room.code}`);
    expect(j2.statusCode).toBe(200);
    const seats = (
      await db.query(
        `SELECT payload FROM events WHERE session_id=$1 AND type='SeatJoined'`,
        [room.id],
      )
    ).rows.map((r) => r.payload);
    expect(seats).toHaveLength(2); // host + guest once
    expect(Object.keys(seats[1]).sort()).toEqual([
      'accountId',
      'displayName',
      'matureOptOut',
      'presence',
      'seatId',
    ]);
    expect(
      (await call(guest, 'GET', '/api/rooms'))
        .json()
        .rooms.map((r: { id: string }) => r.id),
    ).toContain(room.id);
    // guest can get a ws ticket
    const t = await app.inject({
      method: 'POST',
      url: '/api/ws-ticket',
      headers: {
        cookie: guest.cookie,
        origin: 'http://localhost',
        host: 'localhost',
      },
      payload: { sessionId: room.id },
    });
    expect(t.statusCode).toBe(200);
    // guests cannot manage the invite
    expect(
      (await call(guest, 'POST', `/api/rooms/${room.id}/invite`)).statusCode,
    ).toBe(403);
    // regenerate invalidates old code
    const regen = (
      await call(host, 'POST', `/api/rooms/${room.id}/invite`)
    ).json().room;
    expect(regen.code).not.toBe(room.code);
    const late = await account();
    const invalidOld = await call(
      late,
      'POST',
      `/api/invites/${room.code}/join`,
    );
    expect(invalidOld.statusCode).toBe(404);
    expect(invalidOld.json()).toMatchObject({ code: 'INVITE_INVALID' });
    const acceptedNew = await call(
      late,
      'POST',
      `/api/invites/${regen.code}/join`,
    );
    expect(acceptedNew.statusCode).toBe(200);
    expect(acceptedNew.json().room).toMatchObject({
      id: room.id,
      isHost: false,
    });
    // revoke kills the new one
    expect(
      (await call(host, 'DELETE', `/api/rooms/${room.id}/invite`)).statusCode,
    ).toBe(200);
    expect(
      (await call(late, 'POST', `/api/join/${regen.code}`)).statusCode,
    ).toBe(404);
  });

  it('unverified account gets 403 on create', async () => {
    const pending = await account('pending_email');
    const res = await call(pending, 'POST', '/api/rooms', { name: 'x' });
    expect(res.statusCode).toBe(403);
  });

  it('enforces 6 seats under parallel joins', async () => {
    const host = await account();
    const { room } = (
      await call(host, 'POST', '/api/rooms', { name: 'Full' })
    ).json();
    const guests = await Promise.all(
      Array.from({ length: 10 }, () => account()),
    );
    const results = await Promise.all(
      guests.map((g) => call(g, 'POST', `/api/join/${room.code}`)),
    );
    const codes = results.map((r) => r.statusCode);
    expect(codes.filter((c) => c === 200)).toHaveLength(5);
    expect(codes.filter((c) => c === 409)).toHaveLength(5);
    const n = await db.query(
      `SELECT count(*)::int AS n FROM events WHERE session_id=$1 AND type='SeatJoined'`,
      [room.id],
    );
    expect(n.rows[0].n).toBe(6);
    // already-seated account re-joins even when full
    const seated = guests[results.findIndex((r) => r.statusCode === 200)]!;
    expect(
      (await call(seated, 'POST', `/api/join/${room.code}`)).statusCode,
    ).toBe(200);
  });
});
