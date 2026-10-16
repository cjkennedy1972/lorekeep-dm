import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { currentMemberSql } from '../../src/room/membership.js';
import { sessionForCode, hashInvite } from '../../src/rooms/invites.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL required');

const isMember = `SELECT EXISTS (SELECT 1 FROM sessions s WHERE s.id=$2 AND ${currentMemberSql('$1')}) AS ok`;

let db: Pool;
let owner: string;
let player: string;
let room: string;
let seq = 0;

async function event(type: string, payload: Record<string, unknown>) {
  seq += 1;
  await db.query(
    'INSERT INTO events(session_id,seq,turn_id,type,payload) VALUES($1,$2,$3,$4,$5::jsonb)',
    [room, seq, randomUUID(), type, JSON.stringify(payload)],
  );
}
async function memberOf(accountId: string) {
  const r = await db.query<{ ok: boolean }>(isMember, [accountId, room]);
  return r.rows[0].ok;
}

beforeAll(async () => {
  db = new Pool({ connectionString: databaseUrl });
  owner = randomUUID();
  player = randomUUID();
  room = randomUUID();
  for (const id of [owner, player])
    await db.query(
      `INSERT INTO accounts(id,email,password_hash,display_name,status,is_adult,age_checked_at,terms_version,terms_accepted_at) VALUES($1,$2,'hash','P','active',true,now(),'v1',now())`,
      [id, `${id}@example.test`],
    );
  await db.query(
    `INSERT INTO sessions(id,owner_account_id,name,status) VALUES($1,$2,'Revocation','active')`,
    [room, owner],
  );
});

afterAll(async () => {
  await db.end();
});

describe('current membership after voluntary leave', () => {
  it('a joined seat is a member until a later SeatRevoked for that seat', async () => {
    const seatA = randomUUID();
    await event('SeatJoined', { accountId: player, seatId: seatA });
    expect(await memberOf(player)).toBe(true);

    await event('SeatRevoked', { accountId: player, seatId: seatA });
    expect(await memberOf(player)).toBe(false);
  });

  it('a rejoin after revocation mints a new seat and counts again', async () => {
    const seatB = randomUUID();
    await event('SeatJoined', { accountId: player, seatId: seatB });
    expect(await memberOf(player)).toBe(true);
  });

  it('presence changes alone never grant or remove membership', async () => {
    const stranger = randomUUID();
    await event('PresenceChanged', { accountId: stranger, online: false });
    expect(await memberOf(stranger)).toBe(false);
  });

  it('a valid invite permits rejoining after revocation; history alone does not', async () => {
    const code = randomBytes(16).toString('base64url');
    await db.query('UPDATE sessions SET invite_hash=$2 WHERE id=$1', [
      room,
      hashInvite(code),
    ]);
    const leaver = randomUUID();
    const seat = randomUUID();
    await db.query(
      `INSERT INTO accounts(id,email,password_hash,display_name,status,is_adult,age_checked_at,terms_version,terms_accepted_at) VALUES($1,$2,'hash','L','active',true,now(),'v1',now())`,
      [leaver, `${leaver}@example.test`],
    );
    await event('SeatJoined', { accountId: leaver, seatId: seat });
    expect(await sessionForCode(db, code)).toBeDefined();
    await event('SeatRevoked', { accountId: leaver, seatId: seat });
    expect(await memberOf(leaver)).toBe(false);
    expect(await sessionForCode(db, code)).toBeDefined();
    await db.query('UPDATE sessions SET invite_hash=NULL WHERE id=$1', [room]);
    expect(await sessionForCode(db, code)).toBeUndefined();
  });
});
