import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import WebSocket from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { installGateway } from '../../src/gateway/ws.js';
import { ConnectionRegistry } from '../../src/gateway/connections.js';
import { consumeTicket, issueTicket } from '../../src/gateway/tickets.js';
import { createSession } from '../../src/accounts/sessions.js';
import { hashToken } from '../../src/accounts/signup.js';
import { Persistence } from '../../src/persistence/index.js';
import { RoomRegistry } from '../../src/room/registry.js';
import { SessionLease } from '../../src/room/lease.js';

const db = new Pool({ connectionString: process.env.DATABASE_URL });
const connections = new ConnectionRegistry(db);
const app = createApp(db, { connections });
const rooms = new RoomRegistry(
  new Persistence(db),
  new SessionLease(db),
  'ws-revocation',
);
installGateway(app, db, rooms, connections, 300);
let base: string;
const accounts: string[] = [];
const roomIds: string[] = [];

async function setup() {
  const accountId = randomUUID();
  const sessionId = randomUUID();
  await db.query(
    `INSERT INTO accounts(id,email,password_hash,display_name,status,is_adult,age_checked_at,terms_version,terms_accepted_at) VALUES($1,$2,'hash','P','active',true,now(),'v1',now())`,
    [accountId, `${accountId}@example.test`],
  );
  await db.query('INSERT INTO sessions(id,owner_account_id) VALUES($1,$2)', [
    sessionId,
    accountId,
  ]);
  accounts.push(accountId);
  roomIds.push(sessionId);
  const token = await createSession(db, accountId, 'test');
  return { accountId, sessionId, token, cookie: `sid=${token}` };
}
const ticketFor = async (cookie: string) => {
  const res = await fetch(`${base}/api/ws-ticket`, {
    method: 'POST',
    headers: { origin: base, cookie },
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { ticket: string }).ticket;
};
const open = (ticket: string) =>
  new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(
      `${base.replace('http', 'ws')}/ws?ticket=${ticket}`,
      {
        origin: base,
      },
    );
    ws.once('message', () => resolve(ws)); // first frame is StateSync
    ws.once('close', (code) => reject(new Error(`closed ${code}`)));
  });
const closeInfo = (ws: WebSocket, ms = 2000) =>
  new Promise<{ code: number; reason: string; ms: number }>(
    (resolve, reject) => {
      const t0 = Date.now();
      const timer = setTimeout(
        () => reject(new Error('socket stayed open')),
        ms,
      );
      ws.once('close', (code, reason) => {
        clearTimeout(timer);
        resolve({ code, reason: reason.toString(), ms: Date.now() - t0 });
      });
    },
  );
const post = (path: string, cookie: string, method = 'POST') =>
  fetch(`${base}${path}`, { method, headers: { origin: base, cookie } });

beforeAll(async () => {
  base = await app.listen({ host: '127.0.0.1', port: 0 });
});
afterAll(async () => {
  await rooms.drain();
  await app.close();
  // events are append-only, so rows are left behind (random ids, as in the other db tests)
  await db.end();
});

describe('websocket survives neither revocation nor deactivation', () => {
  it('logout closes the socket within 2s, Resync gets no reply, and an unused ticket is dead', async () => {
    const u = await setup();
    const ws = await open(await ticketFor(u.cookie));
    const unused = await ticketFor(u.cookie);
    const messages: string[] = [];
    ws.on('message', (d) => messages.push(d.toString()));
    const closing = closeInfo(ws);
    expect((await post('/api/logout', u.cookie)).status).toBe(200);
    const info = await closing;
    expect(info.code).toBe(4401);
    expect(info.reason).toBe('session revoked');
    expect(info.ms).toBeLessThan(2000);
    ws.send(JSON.stringify({ type: 'Resync', actionId: randomUUID() }));
    await new Promise((r) => setTimeout(r, 300));
    expect(messages).toHaveLength(0);
    expect(await consumeTicket(db, unused)).toBeUndefined();
    const denied = new WebSocket(
      `${base.replace('http', 'ws')}/ws?ticket=${unused}`,
      { origin: base },
    );
    expect((await closeInfo(denied)).code).toBe(1008);
  });
  it('ticket is bound to its auth session and needs an active account', async () => {
    const u = await setup();
    const other = await createSession(db, u.accountId, 'other');
    const t = await issueTicket(db, u.accountId, u.sessionId, hashToken(other));
    await db.query('DELETE FROM auth_sessions WHERE token_hash=$1', [
      hashToken(other),
    ]);
    expect(
      (
        await db.query('SELECT 1 FROM ws_tickets WHERE auth_token_hash=$1', [
          hashToken(other),
        ])
      ).rowCount,
    ).toBe(0); // cascade deleted the ticket
    expect(await consumeTicket(db, t)).toBeUndefined();
    const t2 = await issueTicket(
      db,
      u.accountId,
      u.sessionId,
      hashToken(u.token),
    );
    await db.query("UPDATE accounts SET status='deleting' WHERE id=$1", [
      u.accountId,
    ]);
    expect(await consumeTicket(db, t2)).toBeUndefined();
  });
  it('account set to deleting closes the socket (cross-node path via periodic tick)', async () => {
    const u = await setup();
    const ws = await open(await ticketFor(u.cookie));
    const closing = closeInfo(ws);
    await db.query("UPDATE accounts SET status='deleting' WHERE id=$1", [
      u.accountId,
    ]);
    expect((await closing).code).toBe(4401);
  });
  it('DELETE /api/me/sessions/:id closes only that device, revoke-others closes the rest', async () => {
    const u = await setup();
    const second = await createSession(db, u.accountId, 'second');
    const wsA = await open(await ticketFor(u.cookie));
    const wsB = await open(await ticketFor(`sid=${second}`));
    const closeB = closeInfo(wsB);
    expect(
      (await post(`/api/me/sessions/${hashToken(second)}`, u.cookie, 'DELETE'))
        .status,
    ).toBe(200);
    expect((await closeB).code).toBe(4401);
    expect(wsA.readyState).toBe(WebSocket.OPEN);
    const third = await createSession(db, u.accountId, 'third');
    const wsC = await open(await ticketFor(`sid=${third}`));
    const closeC = closeInfo(wsC);
    expect(
      (await post('/api/me/sessions/revoke-others', u.cookie)).status,
    ).toBe(200);
    expect((await closeC).code).toBe(4401);
    expect(wsA.readyState).toBe(WebSocket.OPEN);
    wsA.close();
  });
});
