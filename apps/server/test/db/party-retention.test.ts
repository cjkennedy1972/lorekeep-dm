import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { createSession } from '../../src/accounts/sessions.js';
import { Persistence } from '../../src/persistence/index.js';
import { RoomRegistry } from '../../src/room/registry.js';
import { SessionLease } from '../../src/room/lease.js';
import { LocalObjectStore } from '../../src/storage/objectStore.js';
import { runSweep } from '../../src/retention/sweeper.js';

const db = new Pool({ connectionString: process.env.DATABASE_URL });
const rooms = new RoomRegistry(
  new Persistence(db),
  new SessionLease(db),
  'party-retention-test',
);
const app = createApp(db, { rooms, joinRateLimit: 100 });
const store = new LocalObjectStore(
  await mkdtemp(join(tmpdir(), 'party-sweep-')),
);

afterAll(async () => {
  await rooms.drain();
  await app.close();
  await db.end();
});

async function account() {
  const id = randomUUID();
  await db.query(
    `INSERT INTO accounts(id,email,password_hash,display_name,status,is_adult,age_checked_at,terms_version,terms_accepted_at)
     VALUES($1,$2,'x',$3,'active',true,now(),'t',now())`,
    [id, `${id}@example.test`, `P-${id.slice(0, 4)}`],
  );
  return { id, cookie: `sid=${await createSession(db, id, 'test')}` };
}

async function party(host: { cookie: string }) {
  const made = await app.inject({
    method: 'POST',
    url: '/api/rooms',
    headers: { cookie: host.cookie },
    payload: { name: 'Long Table' },
  });
  expect(made.statusCode).toBe(201);
  return made.json().room as { id: string; code: string };
}

async function idleFor(sessionId: string, days: number) {
  await db.query(
    `UPDATE sessions SET last_active_at = now() - ($2::int * interval '1 day') WHERE id=$1`,
    [sessionId, days],
  );
}

async function sweep() {
  let result;
  while (!result) result = await runSweep(db, { store, log: () => {} });
  return result;
}

async function statusOf(sessionId: string) {
  return (
    await db.query<{ status: string }>(
      'SELECT status FROM sessions WHERE id=$1',
      [sessionId],
    )
  ).rows[0]?.status;
}

describe('party retention (postgres)', () => {
  it('an active party table is not archived by the sweeper', async () => {
    const host = await account();
    const room = await party(host);
    await idleFor(room.id, 20);
    await (await rooms.get(room.id)).submit(randomUUID());
    await sweep();
    expect(await statusOf(room.id)).toBe('active');
  });

  it('an idle party table is archived after 14 days', async () => {
    const host = await account();
    const room = await party(host);
    await idleFor(room.id, 20);
    await sweep();
    expect(await statusOf(room.id)).toBe('archived');
  });

  it('an archived table is deleted 90 days after archive, unless a legal hold is set', async () => {
    const host = await account();
    const expired = await party(host);
    const held = await party(host);
    for (const room of [expired, held])
      await db.query(
        `UPDATE sessions SET status='archived', archived_at=now() - interval '91 days' WHERE id=$1`,
        [room.id],
      );
    await db.query(
      "INSERT INTO legal_holds(kind,item_id) VALUES('session',$1) ON CONFLICT DO NOTHING",
      [held.id],
    );
    await sweep();
    expect(await statusOf(expired.id)).toBeUndefined();
    expect(await statusOf(held.id)).toBe('archived');
    await db.query('DELETE FROM legal_holds WHERE item_id=$1', [held.id]);
  });

  it('a member who rejoins an archived party restores it; a stranger does not', async () => {
    const host = await account();
    const guest = await account();
    const stranger = await account();
    const room = await party(host);
    const joined = await app.inject({
      method: 'POST',
      url: `/api/join/${room.code}`,
      headers: { cookie: guest.cookie },
    });
    expect(joined.statusCode).toBe(200);
    await db.query(
      `UPDATE sessions SET status='archived', archived_at=now() WHERE id=$1`,
      [room.id],
    );

    const strangerTry = await app.inject({
      method: 'POST',
      url: `/api/join/${room.code}`,
      headers: { cookie: stranger.cookie },
    });
    expect(strangerTry.statusCode).toBe(404);
    expect(await statusOf(room.id)).toBe('archived');

    const rejoined = await app.inject({
      method: 'POST',
      url: `/api/join/${room.code}`,
      headers: { cookie: guest.cookie },
    });
    expect(rejoined.statusCode).toBe(200);
    expect(await statusOf(room.id)).toBe('active');
  });
});
