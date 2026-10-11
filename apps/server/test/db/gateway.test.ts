import { allowInputGate } from '../support/allowInputGate.js';
import { randomUUID, createHash } from 'node:crypto';
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
const db = new Pool({ connectionString: process.env.DATABASE_URL });
const app = createApp(db, { inputGate: allowInputGate });
const rooms = new RoomRegistry(
  new Persistence(db),
  new SessionLease(db),
  'gateway-test',
);
installGateway(app, db, rooms);
let base: string;
const accounts = [randomUUID(), randomUUID()];
const sessionId = randomUUID();
let tokens: string[];
function next(ws: WebSocket): Promise<{
  type: string;
  seq: number;
  payload: { state: { seats: unknown[] }; presence?: string };
}> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('socket timeout')), 3000);
    ws.once('message', (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()));
    });
  });
}
function closed(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => ws.once('close', (code) => resolve(code)));
}
async function ticket(token: string) {
  const res = await fetch(`${base}/api/ws-ticket`, {
    method: 'POST',
    headers: { origin: base, cookie: `sid=${token}` },
  });
  expect(res.status).toBe(200);
  return (await res.json()).ticket as string;
}
function connect(t: string) {
  return new WebSocket(`${base.replace('http', 'ws')}/ws?ticket=${t}`, {
    origin: base,
  });
}
beforeAll(async () => {
  for (const [i, id] of accounts.entries())
    await db.query(
      `INSERT INTO accounts(id,email,password_hash,display_name,status,is_adult,age_checked_at,terms_version,terms_accepted_at) VALUES($1,$2,'hash',$3,'active',true,now(),'v1',now())`,
      [id, `${id}@example.test`, `Player ${i}`],
    );
  await db.query('INSERT INTO sessions(id,owner_account_id) VALUES($1,$2)', [
    sessionId,
    accounts[0],
  ]);
  const room = await rooms.get(sessionId);
  await room.join(accounts[1], { send() {} }, 'Player 1');
  await room.disconnect(accounts[1]);
  tokens = await Promise.all(
    accounts.map((id) => createSession(db, id, 'test')),
  );
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  base = address;
});
afterAll(async () => {
  await rooms.drain();
  await app.close();
  await db.end();
});
describe('one-time gateway', () => {
  it('enforces expiry, scope and atomic reuse', async () => {
    const t = await issueTicket(
      db,
      accounts[0],
      sessionId,
      hashToken(tokens[0]),
    );
    expect(await consumeTicket(db, t, randomUUID())).toBeUndefined();
    expect(await consumeTicket(db, t, sessionId)).toMatchObject({
      accountId: accounts[0],
    });
    expect(await consumeTicket(db, t, sessionId)).toBeUndefined();
    const expired = await issueTicket(
      db,
      accounts[0],
      sessionId,
      hashToken(tokens[0]),
    );
    await db.query(
      "UPDATE ws_tickets SET expires_at=now()-interval '1 second' WHERE ticket_hash=$1",
      [createHash('sha256').update(expired).digest('hex')],
    );
    expect(await consumeTicket(db, expired)).toBeUndefined();
  });
  it('syncs two real sockets and broadcasts disconnect', async () => {
    const first = connect(await ticket(tokens[0]));
    const a = await next(first);
    expect(a.type).toBe('StateSync');
    const second = connect(await ticket(tokens[1]));
    const b = await next(second);
    expect(b.type).toBe('StateSync');
    expect(b.payload.state.seats).toHaveLength(2);
    let message = await next(first);
    while (
      message.type !== 'PresenceChanged' ||
      message.payload.presence !== 'online'
    )
      message = await next(first);
    second.close();
    const leave = await next(first);
    expect(leave).toMatchObject({
      type: 'PresenceChanged',
      payload: { presence: 'offline' },
    });
    const reused = connect(await ticket(tokens[0]));
    const badTicket = new URL(reused.url).searchParams.get('ticket')!;
    await next(reused);
    reused.close();
    const denied = connect(badTicket);
    expect(await closed(denied)).toBe(1008);
    first.close();
  });
});
