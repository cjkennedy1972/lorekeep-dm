import { allowInputGate } from '../support/allowInputGate.js';
import { randomUUID, createHash } from 'node:crypto';
import { on } from 'node:events';
import { Pool } from 'pg';
import WebSocket from 'ws';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { installGateway } from '../../src/gateway/ws.js';
import { ConnectionRegistry } from '../../src/gateway/connections.js';
import { consumeTicket, issueTicket } from '../../src/gateway/tickets.js';
import {
  authorizeSeatSocket,
  commitSeatResumeToken,
  releaseSeatSocket,
} from '../../src/gateway/resumeTokens.js';
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
const connections = new ConnectionRegistry(db);
installGateway(app, db, rooms, connections);
let base: string;
const accounts = [randomUUID(), randomUUID(), randomUUID()];
const sessionId = randomUUID();
let tokens: string[];
// Buffered per socket from creation: ws can emit several frames from one TCP chunk,
// and a once('message') registered after an await drops those frames.
const inboxes = new WeakMap<WebSocket, AsyncIterator<unknown[]>>();
const resumeTokens = new Map<string, string>();
const ticketOwners = new Map<string, string>();
const seenMessageTypes = new WeakMap<WebSocket, string[]>();
async function next(
  ws: WebSocket,
  timeoutMs = 3000,
): Promise<{
  type: string;
  seq: number;
  payload: { state: { seats: unknown[] }; presence?: string; claimId?: string };
}> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const { value } = await Promise.race([
      inboxes.get(ws)!.next(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('socket timeout')),
          timeoutMs,
        );
      }),
    ]);
    return JSON.parse(String(value[0]));
  } finally {
    clearTimeout(timer);
  }
}
async function nextOfType(ws: WebSocket, type: string) {
  for (;;) {
    let message;
    try {
      message = await next(ws);
    } catch (error) {
      throw new Error(`waiting for ${type}: ${String(error)}`);
    }
    if (message.type === type) return message;
  }
}
function closed(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => ws.once('close', (code) => resolve(code)));
}
async function closeSocket(ws: WebSocket) {
  if (ws.readyState === WebSocket.CLOSED) return;
  const result = closed(ws);
  ws.close();
  await result;
}
async function waitForReleasedSocket(seatId: string) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const result = await db.query<{ active_socket_id: string | null }>(
      'SELECT active_socket_id FROM seat_resume_tokens WHERE session_id=$1 AND seat_id=$2',
      [sessionId, seatId],
    );
    if (!result.rows[0]?.active_socket_id) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('socket control claim was not released after close');
}
async function ticket(token: string) {
  const res = await fetch(`${base}/api/ws-ticket`, {
    method: 'POST',
    headers: {
      origin: base,
      cookie: `sid=${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ sessionId }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ticket: string };
  ticketOwners.set(body.ticket, token);
  return body.ticket;
}
function connect(t: string, proofOverride?: string, saveResumeToken = true) {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/ws?ticket=${t}`, {
    origin: base,
  });
  inboxes.set(ws, on(ws, 'message'));
  seenMessageTypes.set(ws, []);
  ws.on('message', (raw) => {
    const message = JSON.parse(String(raw)) as {
      type?: string;
      seq?: number;
      payload?: { resumeToken?: string };
    };
    seenMessageTypes.get(ws)!.push(message.type ?? 'unknown');
    if (message.type === 'SeatResumeChallenge')
      ws.send(
        JSON.stringify({
          type: 'ResumeSeat',
          payload: {
            resumeToken:
              proofOverride ?? resumeTokens.get(ticketOwners.get(t)!),
          },
        }),
      );
    if (message.type === 'SeatAuthenticated' && message.payload?.resumeToken) {
      const owner = ticketOwners.get(t);
      if (saveResumeToken && owner)
        resumeTokens.set(owner, message.payload.resumeToken);
    }
    if (message.type === 'StateSync')
      ws.send(
        JSON.stringify({
          actionId: randomUUID(),
          type: 'StateSyncAck',
          payload: { seq: message.seq },
          lastSeq: message.seq,
        }),
      );
  });
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
  for (let i = 0; i < accounts.length; i++) {
    const seat = (await rooms.get(sessionId)).state.seats.find(
      (candidate) => candidate.accountId === accounts[i],
    )!;
    const socketId = randomUUID();
    const authorization = await authorizeSeatSocket(
      db,
      sessionId,
      seat.seatId,
      socketId,
      undefined,
      true,
    );
    if (authorization.status !== 'authorized')
      throw new Error('failed to prepare approved test seat');
    resumeTokens.set(tokens[i]!, authorization.resumeToken);
    await commitSeatResumeToken(
      db,
      sessionId,
      seat.seatId,
      socketId,
      authorization.resumeToken,
    );
    await releaseSeatSocket(db, sessionId, seat.seatId, socketId);
  }
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  base = address;
});
beforeEach(() => connections.resetAuthAttemptHistory());
afterAll(async () => {
  await rooms.drain();
  await app.close();
  await db.end();
});
describe('one-time gateway', () => {
  it('creates a resume-token row whenever a seat is created', async () => {
    const createdSession = randomUUID();
    await db.query('INSERT INTO sessions(id,owner_account_id) VALUES($1,$2)', [
      createdSession,
      accounts[0],
    ]);
    const room = await rooms.get(createdSession);
    const issuedToken = await room.seat(accounts[0], 'Token row player');
    expect(issuedToken).toMatch(/^[A-Za-z0-9_-]{32}$/);
    const seatId = room.state.seats[0]!.seatId;
    const result = await db.query<{ token_hash: string }>(
      'SELECT token_hash FROM seat_resume_tokens WHERE session_id=$1 AND seat_id=$2',
      [createdSession, seatId],
    );
    expect(result.rowCount).toBe(1);
    expect(result.rows[0]?.token_hash).toBe(
      createHash('sha256').update(issuedToken!).digest('hex'),
    );
    expect(room.pendingSeatResumeToken(accounts[0])).toBe(issuedToken);
    expect(
      await authorizeSeatSocket(
        db,
        createdSession,
        seatId,
        randomUUID(),
        undefined,
      ),
    ).toEqual({ status: 'invalid-token' });
    const accepted = await authorizeSeatSocket(
      db,
      createdSession,
      seatId,
      randomUUID(),
      issuedToken,
    );
    expect(accepted).toMatchObject({ status: 'authorized' });
  });
  it('refuses a ticket-only socket for a seat without a resume-token row', async () => {
    const seatId = (await rooms.get(sessionId)).state.seats.find(
      (seat) => seat.accountId === accounts[0],
    )!.seatId;
    await db.query(
      'DELETE FROM seat_resume_tokens WHERE session_id=$1 AND seat_id=$2',
      [sessionId, seatId],
    );
    const result = await authorizeSeatSocket(
      db,
      sessionId,
      seatId,
      randomUUID(),
      undefined,
    );
    expect(result).toEqual({ status: 'invalid-token' });
    // Restore fixture state through the same host-approved recovery path.
    const socketId = randomUUID();
    const recovered = await authorizeSeatSocket(
      db,
      sessionId,
      seatId,
      socketId,
      undefined,
      true,
    );
    expect(recovered).toMatchObject({ status: 'authorized' });
    if (recovered.status === 'authorized') {
      resumeTokens.set(tokens[0]!, recovered.resumeToken);
      await commitSeatResumeToken(
        db,
        sessionId,
        seatId,
        socketId,
        recovered.resumeToken,
      );
    }
    await releaseSeatSocket(db, sessionId, seatId, socketId);
  });
  it('requires and rotates the per-seat resume token', async () => {
    const firstTicket = await ticket(tokens[0]);
    expect(firstTicket).toBeTruthy();
    const first = connect(firstTicket);
    await nextOfType(first, 'SeatAuthenticated');
    await nextOfType(first, 'StateSync');
    const current = resumeTokens.get(tokens[0])!;
    expect(current).toBeTruthy();
    // Mint while this token is current, before the next authenticated socket rotates it.
    const staleTicket = await ticket(tokens[0]);
    const hostSeatId = (await rooms.get(sessionId)).state.seats.find(
      (seat) => seat.accountId === accounts[0],
    )!.seatId;
    await closeSocket(first);
    await waitForReleasedSocket(hostSeatId);
    const secondTicket = await ticket(tokens[0]);
    const second = connect(secondTicket);
    await nextOfType(second, 'SeatAuthenticated');
    await nextOfType(second, 'StateSync');
    expect(seenMessageTypes.get(second)).not.toContain('SeatTakenOver');
    const rotated = resumeTokens.get(tokens[0])!;
    expect(rotated).not.toBe(current);
    await closeSocket(second);
    await waitForReleasedSocket(hostSeatId);
    const staleIdentity = await consumeTicket(db, staleTicket, sessionId);
    expect(staleIdentity).toMatchObject({ accountId: accounts[0], sessionId });
    const staleAuth = await authorizeSeatSocket(
      db,
      sessionId,
      hostSeatId,
      randomUUID(),
      current,
    );
    expect(staleAuth).toMatchObject({ status: 'invalid-token' });
  });
  it('keeps pending late-join identity details host-only', async () => {
    const host = connect(await ticket(tokens[0]));
    const guest = connect(await ticket(tokens[1]));
    await nextOfType(host, 'StateSync');
    await nextOfType(guest, 'StateSync');
    const requestAccountId = randomUUID();
    await (
      await rooms.get(sessionId)
    ).requestLateJoin(requestAccountId, 'Private requester name');
    let hostSync: Awaited<ReturnType<typeof nextOfType>>;
    do {
      hostSync = await nextOfType(host, 'StateSync');
    } while (
      !hostSync.payload.state.lateJoinRequests?.some(
        (request) => request.accountId === requestAccountId,
      )
    );
    const guestSync = await nextOfType(guest, 'StateSync');
    expect(guestSync.payload.state).not.toHaveProperty('lateJoinRequests');
    await Promise.all([closeSocket(host), closeSocket(guest)]);
    await Promise.all(
      [accounts[0], accounts[1]].map(async (accountId) => {
        const seatId = (await rooms.get(sessionId)).state.seats.find(
          (seat) => seat.accountId === accountId,
        )!.seatId;
        await waitForReleasedSocket(seatId);
      }),
    );
  });

  it('requires live host approval for a lost-token claim and rotates on grant', async () => {
    const host = connect(await ticket(tokens[0]));
    await nextOfType(host, 'StateSync');
    const bootstrap = connect(await ticket(tokens[1]));
    await nextOfType(bootstrap, 'SeatAuthenticated');
    const claimantSeatId = (await rooms.get(sessionId)).state.seats.find(
      (seat) => seat.accountId === accounts[1],
    )!.seatId;
    await closeSocket(bootstrap);
    await waitForReleasedSocket(claimantSeatId);

    const previous = resumeTokens.get(tokens[1])!;
    const claimant = connect(await ticket(tokens[1]), 'lost-token');
    const pending = await nextOfType(claimant, 'SeatClaimPending');
    const claimId = pending.payload.claimId!;
    await nextOfType(host, 'SeatClaimRequested');
    const room = await rooms.get(sessionId);
    host.send(
      JSON.stringify({
        actionId: randomUUID(),
        type: 'ApproveSeatClaim',
        payload: { claimId },
        lastSeq: room.seq,
      }),
    );
    await nextOfType(claimant, 'SeatAuthenticated');
    expect(resumeTokens.get(tokens[1])).not.toBe(previous);
    await Promise.all([closeSocket(claimant), closeSocket(host)]);
    await Promise.all([
      waitForReleasedSocket(claimantSeatId),
      waitForReleasedSocket(
        (await rooms.get(sessionId)).state.seats.find(
          (seat) => seat.accountId === accounts[0],
        )!.seatId,
      ),
    ]);
  });
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
    const a = await nextOfType(first, 'StateSync');
    expect(a.type).toBe('StateSync');
    const second = connect(await ticket(tokens[1]));
    const b = await nextOfType(second, 'StateSync');
    expect(b.type).toBe('StateSync');
    expect(b.payload.state.seats).toHaveLength(3);
    second.close();
    await closeSocket(second);
    const room = await rooms.get(sessionId);
    for (let attempt = 0; attempt < 100; attempt++) {
      if (
        room.state.seats.find((seat) => seat.accountId === accounts[1])
          ?.presence === 'disconnected'
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(
      room.state.seats.find((seat) => seat.accountId === accounts[1])?.presence,
    ).toBe('disconnected');
    await closeSocket(second);
    await waitForReleasedSocket(
      (await rooms.get(sessionId)).state.seats.find(
        (seat) => seat.accountId === accounts[1],
      )!.seatId,
    );
    await closeSocket(first);
  }, 20_000);

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
    await Promise.all([
      closeSocket(host),
      closeSocket(guest),
      closeSocket(secondGuest),
    ]);
    await Promise.all(
      room.state.seats.map((seat) => waitForReleasedSocket(seat.seatId)),
    );
  });

  it('rejects a host command after its seat is revoked in persisted membership', async () => {
    const revokedSessionId = randomUUID();
    await db.query('INSERT INTO sessions(id,owner_account_id) VALUES($1,$2)', [
      revokedSessionId,
      accounts[0],
    ]);
    const room = await rooms.get(revokedSessionId);
    const initialResumeToken = await room.seat(accounts[0], 'Player 0');
    expect(initialResumeToken).toBeTruthy();
    const revokedTicket = await issueTicket(
      db,
      accounts[0],
      revokedSessionId,
      hashToken(tokens[0]),
    );
    ticketOwners.set(revokedTicket, tokens[0]);
    const host = connect(revokedTicket, initialResumeToken, false);
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
    expect(
      (
        await db.query(
          'SELECT 1 FROM seat_resume_tokens WHERE session_id=$1 AND seat_id=$2',
          [revokedSessionId, seat.seatId],
        )
      ).rowCount,
    ).toBe(0);
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
    await closeSocket(host);
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
    // The host's reconnect hold may auto-resume the table after its sync. Re-pause
    // once both sockets are ready so this test exercises paused-chat policy itself.
    await room.setPaused(accounts[0], true, true);
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
    await Promise.all([closeSocket(host), closeSocket(guest)]);
    await Promise.all(
      [accounts[0], accounts[1]].map(async (accountId) => {
        const seatId = (await rooms.get(sessionId)).state.seats.find(
          (seat) => seat.accountId === accountId,
        )!.seatId;
        await waitForReleasedSocket(seatId);
      }),
    );
  });
});
