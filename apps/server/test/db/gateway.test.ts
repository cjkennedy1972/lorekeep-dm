import { allowInputGate } from '../support/allowInputGate.js';
import { randomUUID, createHash } from 'node:crypto';
import { on } from 'node:events';
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
  'gateway-test',
);
installGateway(app, db, rooms);
let base: string;
const accounts = [randomUUID(), randomUUID(), randomUUID()];
const sessionId = randomUUID();
let tokens: string[];
// Buffered per socket from creation: ws can emit several frames from one TCP chunk,
// and a once('message') registered after an await drops those frames.
const inboxes = new WeakMap<WebSocket, AsyncIterator<unknown[]>>();
async function next(ws: WebSocket): Promise<{
  type: string;
  seq: number;
  payload: { state: { seats: unknown[] }; presence?: string };
}> {
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
async function nextOfType(ws: WebSocket, type: string) {
  for (;;) {
    const message = await next(ws);
    if (message.type === type) return message;
  }
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
      [id, `${id}@example.test`, `Player ${i}`],
    );
  await db.query('INSERT INTO sessions(id,owner_account_id) VALUES($1,$2)', [
    sessionId,
    accounts[0],
  ]);
  const room = await rooms.get(sessionId);
  await room.seat(accounts[0], 'Player 0');
  await joinSeated(room, accounts[1], { send() {} }, 'Player 1');
  await room.disconnect(accounts[1]);
  await joinSeated(room, accounts[2], { send() {} }, 'Player 2');
  await room.disconnect(accounts[2]);
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
    expect(b.payload.state.seats).toHaveLength(3);
    let message = await next(first);
    while (
      message.type !== 'PresenceChanged' ||
      message.payload.presence !== 'online'
    )
      message = await next(first);
    second.close();
    let leave = await next(first);
    while (
      leave.type !== 'PresenceChanged' ||
      leave.payload.presence !== 'offline'
    )
      leave = await next(first);
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

  it('rejects every host command from a seated non-host socket', async () => {
    const room = await rooms.get(sessionId);
    const host = connect(await ticket(tokens[0]));
    await nextOfType(host, 'StateSync');
    const guest = connect(await ticket(tokens[1]));
    await nextOfType(guest, 'StateSync');
    const targetSeatId = room.state.seats.find(
      (seat) => seat.accountId === accounts[0],
    )!.seatId;
    const secondGuest = connect(await ticket(tokens[2]));
    await nextOfType(secondGuest, 'StateSync');
    const commands = [
      { type: 'KickSeat', payload: { seatId: targetSeatId } },
      { type: 'TransferHost', payload: { seatId: targetSeatId } },
      { type: 'ApproveLateJoin', payload: { requestId: randomUUID() } },
      { type: 'DenyLateJoin', payload: { requestId: randomUUID() } },
      { type: 'EndTable', payload: {} },
      { type: 'ConfigureRoundTimer', payload: { durationMs: 30_000 } },
      { type: 'MuteChat', payload: { seatId: targetSeatId, muted: true } },
    ];
    for (const [index, command] of commands.entries()) {
      const actionId = randomUUID();
      const commandSocket = index === commands.length - 1 ? secondGuest : guest;
      commandSocket.send(
        JSON.stringify({ ...command, actionId, lastSeq: room.seq }),
      );
      await expect(nextOfType(commandSocket, 'Error')).resolves.toMatchObject({
        payload: { code: 'NOT_HOST', actionId },
      });
    }
    expect(room.state.ended).not.toBe(true);
    host.close();
    guest.close();
    secondGuest.close();
  });

  it('rejects a host command after its seat is revoked in persisted membership', async () => {
    const revokedSessionId = randomUUID();
    await db.query('INSERT INTO sessions(id,owner_account_id) VALUES($1,$2)', [
      revokedSessionId,
      accounts[0],
    ]);
    const room = await rooms.get(revokedSessionId);
    await room.seat(accounts[0], 'Player 0');
    const revokedTicket = await issueTicket(
      db,
      accounts[0],
      revokedSessionId,
      hashToken(tokens[0]),
    );
    const host = connect(revokedTicket);
    await nextOfType(host, 'StateSync');
    const seat = room.state.seats.find(
      (candidate) => candidate.accountId === accounts[0],
    )!;
    // Keep the stale socket open but remove its Room connection so closing the
    // test socket cannot enqueue another event after the direct revocation.
    await room.disconnect(accounts[0]);
    let storedSeq = -1;
    for (let attempt = 0; attempt < 20; attempt++) {
      const result = await db.query<{ seq: number }>(
        'SELECT COALESCE(max(seq),0)::int AS seq FROM events WHERE session_id=$1',
        [revokedSessionId],
      );
      storedSeq = result.rows[0]!.seq;
      if (storedSeq === room.seq) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(storedSeq).toBe(room.seq);
    await db.query(
      `INSERT INTO events(session_id,seq,turn_id,type,payload) VALUES($1,$2,$3,'SeatRevoked',$4::jsonb)`,
      [
        revokedSessionId,
        storedSeq + 1,
        randomUUID(),
        JSON.stringify({ seatId: seat.seatId, accountId: accounts[0] }),
      ],
    );
    const actionId = randomUUID();
    host.send(
      JSON.stringify({
        type: 'EndTable',
        payload: {},
        actionId,
        lastSeq: room.seq,
      }),
    );
    await expect(nextOfType(host, 'Error')).resolves.toMatchObject({
      payload: { code: 'SEAT_REVOKED', actionId },
    });
    expect(room.state.ended).not.toBe(true);
    expect(
      await db.query('SELECT status FROM sessions WHERE id=$1', [
        revokedSessionId,
      ]),
    ).toMatchObject({ rows: [{ status: 'active' }] });
    host.close();
  });

  it('rejects player chat while paused without persisting or broadcasting it', async () => {
    const room = await rooms.get(sessionId);
    await room.setPaused(accounts[0], true, true);
    expect(room.state.paused).toBe(true);
    app.inputGate.checkChat = async () => ({
      decision: 'allow',
      category: 'none',
      source: 'judge',
      attributable: false,
    });

    const host = connect(await ticket(tokens[0]));
    await nextOfType(host, 'StateSync').catch((error) => {
      throw new Error(`waiting for host sync: ${String(error)}`);
    });
    const guest = connect(await ticket(tokens[1]));
    await nextOfType(guest, 'StateSync').catch((error) => {
      throw new Error(`waiting for guest sync: ${String(error)}`);
    });
    const before = await db.query(
      "SELECT count(*)::int AS count FROM events WHERE session_id=$1 AND type IN ('chat.committed','chat.rejected')",
      [sessionId],
    );

    guest.send(
      JSON.stringify({
        actionId: randomUUID(),
        type: 'ChatSend',
        payload: { text: 'This should not be delivered.' },
        lastSeq: room.seq,
      }),
    );
    const rejected = await nextOfType(guest, 'Error').catch((error) => {
      throw new Error(`waiting for paused-chat rejection: ${String(error)}`);
    });
    expect(rejected).toMatchObject({
      type: 'Error',
      payload: { code: 'CHAT_REJECTED', message: 'The table is paused.' },
    });

    host.send(
      JSON.stringify({
        actionId: randomUUID(),
        type: 'ChatSend',
        payload: { text: 'Host message while paused.' },
        lastSeq: room.seq,
      }),
    );
    const hostMessage = await nextOfType(host, 'ChatMessage').catch((error) => {
      throw new Error(`waiting for host chat: ${String(error)}`);
    });
    expect(hostMessage).toMatchObject({
      type: 'ChatMessage',
      payload: { text: 'Host message while paused.' },
    });
    const after = await db.query(
      "SELECT count(*)::int AS count FROM events WHERE session_id=$1 AND type IN ('chat.committed','chat.rejected')",
      [sessionId],
    );
    expect(after.rows[0]?.count).toBe(Number(before.rows[0]?.count) + 1);
    const privateMessages = await db.query(
      "SELECT payload->>'text' AS text FROM events WHERE session_id=$1 AND type='chat.committed'",
      [sessionId],
    );
    expect(privateMessages.rows.map((row) => row.text)).not.toContain(
      'This should not be delivered.',
    );
    expect(
      await db.query('SELECT 1 FROM chat_mutes WHERE session_id=$1', [
        sessionId,
      ]),
    ).toMatchObject({ rowCount: 0 });
    host.close();
    guest.close();
  });
});
