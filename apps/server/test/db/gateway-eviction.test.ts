import { allowInputGate } from '../support/allowInputGate.js';
import { randomUUID } from 'node:crypto';
import { on } from 'node:events';
import { Pool } from 'pg';
import WebSocket from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { installGateway } from '../../src/gateway/ws.js';
import { createSession } from '../../src/accounts/sessions.js';
import { Persistence } from '../../src/persistence/index.js';
import { RoomRegistry } from '../../src/room/registry.js';
import { SessionLease } from '../../src/room/lease.js';
import { joinSeated } from '../helpers/room.js';

const db = new Pool({ connectionString: process.env.DATABASE_URL });
const app = createApp(db, { inputGate: allowInputGate });
const rooms = new RoomRegistry(
  new Persistence(db),
  new SessionLease(db),
  'gateway-eviction-test',
);
installGateway(app, db, rooms);
const accounts = [randomUUID(), randomUUID()];
const sessionId = randomUUID();
let base: string;
let tokens: string[];

// Buffered per socket from creation: ws can emit several frames from one TCP chunk,
// and a once('message') registered after an await drops those frames.
const inboxes = new WeakMap<WebSocket, AsyncIterator<unknown[]>>();
async function next(ws: WebSocket): Promise<{ type: string }> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const { value } = await Promise.race([
      inboxes.get(ws)!.next(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('socket timeout')), 3000);
      }),
    ]);
    return JSON.parse(String(value[0]));
  } finally {
    clearTimeout(timer);
  }
}

/** Resolves with the close code, or 'open' if the socket is still attached after `ms`. */
function closedWithin(ws: WebSocket, ms: number) {
  return Promise.race([
    new Promise<number>((resolve) => ws.once('close', (code) => resolve(code))),
    new Promise<'open'>((resolve) => setTimeout(() => resolve('open'), ms)),
  ]);
}

const resumeTokens = new Map<string, string>();
async function ticket(token: string) {
  const res = await fetch(`${base}/api/ws-ticket`, {
    method: 'POST',
    headers: {
      origin: base,
      cookie: `sid=${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ sessionId, resumeToken: resumeTokens.get(token) }),
  });
  expect(res.status).toBe(200);
  const result = (await res.json()) as { ticket: string; resumeToken: string };
  resumeTokens.set(token, result.resumeToken);
  return result.ticket;
}

function connect(t: string) {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/ws?ticket=${t}`, {
    origin: base,
  });
  inboxes.set(ws, on(ws, 'message'));
  return ws;
}

beforeAll(async () => {
  for (const [i, id] of accounts.entries())
    await db.query(
      `INSERT INTO accounts(id,email,password_hash,display_name,status,is_adult,age_checked_at,terms_version,terms_accepted_at) VALUES($1,$2,'hash',$3,'active',true,now(),'v1',now())`,
      [id, `${id}@example.test`, `Evict ${i}`],
    );
  await db.query('INSERT INTO sessions(id,owner_account_id) VALUES($1,$2)', [
    sessionId,
    accounts[0],
  ]);
  const room = await rooms.get(sessionId);
  await joinSeated(room, accounts[1]!, { send() {} }, 'Evict 1');
  await room.disconnect(accounts[1]!);
  tokens = await Promise.all(
    accounts.map((id) => createSession(db, id, 'test')),
  );
  base = await app.listen({ host: '127.0.0.1', port: 0 });
});

afterAll(async () => {
  await rooms.drain();
  await app.close();
  await db.query('SELECT purge_session($1)', [sessionId]);
  await db.end();
});

describe('room eviction and attached sockets', () => {
  it('closes a socket attached to an evicted room so the client reattaches to a fresh one', async () => {
    const heir = connect(await ticket(tokens[1]!));
    expect((await next(heir)).type).toBe('StateSync');

    const closing = closedWithin(heir, 2000);
    await rooms.evictSession(sessionId);

    expect(await closing).not.toBe('open');
    const fresh = connect(await ticket(tokens[1]!));
    expect((await next(fresh)).type).toBe('StateSync');
    fresh.close();
  });
});
