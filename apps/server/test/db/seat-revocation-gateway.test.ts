import { allowInputGate } from '../support/allowInputGate.js';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import WebSocket from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { installGateway } from '../../src/gateway/ws.js';
import { consumeTicket, issueTicket } from '../../src/gateway/tickets.js';
import { createSession } from '../../src/accounts/sessions.js';
import { hashToken } from '../../src/accounts/signup.js';
import { Persistence } from '../../src/persistence/index.js';
import { RoomRegistry } from '../../src/room/registry.js';
import { SessionLease } from '../../src/room/lease.js';
import { joinSeated } from '../helpers/room.js';

const db = new Pool({ connectionString: process.env.DATABASE_URL });
const app = createApp(db, { inputGate: allowInputGate });
const rooms = new RoomRegistry(
  new Persistence(db),
  new SessionLease(db),
  'seat-revocation-test',
);
installGateway(app, db, rooms);

const sessionId = randomUUID();
const owner = randomUUID();
const leaver = randomUUID();
const stale = randomUUID();
let base: string;
let leaverToken: string;
let staleToken: string;

function closed(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) =>
    ws.once('close', (code, reason) =>
      resolve({ code, reason: reason.toString() }),
    ),
  );
}
function connect(ticket: string) {
  const ws = new WebSocket(
    `${base.replace('http', 'ws')}/ws?ticket=${ticket}`,
    {
      origin: base,
    },
  );
  ws.on('message', (data) => {
    const frame = JSON.parse(data.toString()) as { type: string };
    if (frame.type === 'SeatResumeChallenge')
      ws.send(JSON.stringify({ type: 'ResumeSeat', payload: {} }));
  });
  return ws;
}

beforeAll(async () => {
  for (const id of [owner, leaver, stale])
    await db.query(
      `INSERT INTO accounts(id,email,password_hash,display_name,status,is_adult,age_checked_at,terms_version,terms_accepted_at) VALUES($1,$2,'hash','P','active',true,now(),'v1',now())`,
      [id, `${id}@example.test`],
    );
  await db.query('INSERT INTO sessions(id,owner_account_id) VALUES($1,$2)', [
    sessionId,
    owner,
  ]);
  const room = await rooms.get(sessionId);
  await room.seat(owner, 'Owner');
  await joinSeated(room, leaver, { send() {} }, 'Leaver');
  leaverToken = await createSession(db, leaver, 'test');
  staleToken = await createSession(db, stale, 'test');
  base = await app.listen({ host: '127.0.0.1', port: 0 });
});

afterAll(async () => {
  await rooms.drain();
  await app.close();
  await db.end();
});

describe('seat revocation at the gateway', () => {
  it('a ticket minted before revocation cannot be consumed after it', async () => {
    const usable = await issueTicket(
      db,
      leaver,
      sessionId,
      hashToken(leaverToken),
    );
    expect(await consumeTicket(db, usable, sessionId)).toMatchObject({
      accountId: leaver,
    });

    const revoked = await issueTicket(
      db,
      leaver,
      sessionId,
      hashToken(leaverToken),
    );
    const room = await rooms.get(sessionId);
    await room.leave(leaver);
    expect(await consumeTicket(db, revoked, sessionId)).toBeUndefined();
  });

  it('a socket for a revoked seat is refused with 1008 at upgrade', async () => {
    const ticket = await issueTicket(
      db,
      leaver,
      sessionId,
      hashToken(leaverToken),
    );
    const ws = connect(ticket);
    const close = await closed(ws);
    expect(close.code).toBe(1008);
  });

  it('a stale room that no longer seats the account rejects the join with 1008', async () => {
    await db.query(
      `INSERT INTO events(session_id,seq,turn_id,type,payload) VALUES($1,$2,$3,'SeatJoined',$4::jsonb)`,
      [
        sessionId,
        100_000,
        randomUUID(),
        JSON.stringify({ accountId: stale, seatId: randomUUID() }),
      ],
    );
    const ticket = await issueTicket(
      db,
      stale,
      sessionId,
      hashToken(staleToken),
    );
    const ws = connect(ticket);
    const close = await closed(ws);
    expect(close).toEqual({
      code: 1008,
      reason: 'Player is not seated at this table',
    });
  });
});
