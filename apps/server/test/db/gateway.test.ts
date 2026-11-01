import { allowInputGate } from '../support/allowInputGate.js';
import { randomUUID, createHash } from 'node:crypto';
import { on } from 'node:events';
import { Pool } from 'pg';
import WebSocket from 'ws';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { createApp } from '../../src/app.js';
import { installGateway } from '../../src/gateway/ws.js';
import { ConnectionRegistry } from '../../src/gateway/connections.js';
import {
  consumeTicket,
  issueTicket,
  soloOwnerRecoveryTicket,
} from '../../src/gateway/tickets.js';
import * as resumeTokenModule from '../../src/gateway/resumeTokens.js';
import {
  authorizeSeatSocket,
  clearSeatResumeTokenInvalidationPending,
  commitSeatResumeToken,
  invalidateSeatResumeToken,
  markSeatResumeTokenInvalidationPending,
  releaseSeatSocket,
  rollbackSeatResumeToken,
} from '../../src/gateway/resumeTokens.js';
import { createSession } from '../../src/accounts/sessions.js';
import { hashToken } from '../../src/accounts/signup.js';
import { applyHostChatMute } from '../../src/chat/mutes.js';
import { Persistence } from '../../src/persistence/index.js';
import { RoomRegistry } from '../../src/room/registry.js';
import { SessionLease } from '../../src/room/lease.js';
import { joinSeated } from '../helpers/room.js';
import { quickBuild } from '@game/rules-engine';
import { loadCatalog } from '@game/rules-engine/catalog-node';
import { SeatCharacterRepository } from '../../src/persistence/seatCharacters.js';
const db = new Pool({ connectionString: process.env.DATABASE_URL });
const capturedLogs: string[] = [];
const app = createApp(db, {
  inputGate: allowInputGate,
  loggerStream: { write: (chunk) => capturedLogs.push(chunk.toString()) },
});
const rooms = new RoomRegistry(
  new Persistence(db),
  new SessionLease(db),
  'gateway-test',
);
const connections = new ConnectionRegistry(db);
// Explicit test-only opt-in exercises ADR-037 recovery; production defaults off.
installGateway(app, db, rooms, connections, 15_000, true);
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
const receivedFrames = new WeakMap<WebSocket, string[]>();
async function next(
  ws: WebSocket,
  timeoutMs = 8000,
): Promise<{
  type: string;
  seq: number;
  payload: Record<string, unknown>;
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
async function nextOfType(ws: WebSocket, type: string, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let message;
    try {
      message = await next(ws, Math.max(1, deadline - Date.now()));
    } catch (error) {
      throw new Error(
        `waiting for ${type}: ${String(error)}; received ${seenMessageTypes.get(ws)?.join(', ') ?? 'no frames'}`,
      );
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
async function waitForReleasedSocket(seatId: string, forSession = sessionId) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const result = await db.query<{ active_socket_id: string | null }>(
      'SELECT active_socket_id FROM seat_resume_tokens WHERE session_id=$1 AND seat_id=$2',
      [forSession, seatId],
    );
    if (!result.rows[0]?.active_socket_id) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('socket control claim was not released after close');
}
async function ticket(token: string, forSession = sessionId) {
  const res = await fetch(`${base}/api/ws-ticket`, {
    method: 'POST',
    headers: {
      origin: base,
      cookie: `sid=${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ sessionId: forSession }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ticket: string };
  expect(body).toEqual({ ticket: expect.any(String) });
  expect(JSON.stringify(body)).not.toMatch(/resumeToken/i);
  ticketOwners.set(body.ticket, token);
  return body.ticket;
}
function connect(
  t: string,
  proofOverride?: string | null,
  saveResumeToken = true,
  cookieToken?: string | null,
  gatewayBase = base,
  acknowledgeStateSync = true,
) {
  const ownerToken = ticketOwners.get(t);
  const selectedCookie = cookieToken === undefined ? ownerToken : cookieToken;
  const ws = new WebSocket(
    `${gatewayBase.replace('http', 'ws')}/ws?ticket=${t}`,
    {
      origin: gatewayBase,
      ...(selectedCookie
        ? { headers: { cookie: `sid=${selectedCookie}` } }
        : {}),
    },
  );
  inboxes.set(ws, on(ws, 'message'));
  seenMessageTypes.set(ws, []);
  receivedFrames.set(ws, []);
  ws.on('message', (raw) => {
    receivedFrames.get(ws)!.push(String(raw));
    const message = JSON.parse(String(raw)) as {
      type?: string;
      seq?: number;
      payload?: { resumeToken?: string };
    };
    seenMessageTypes.get(ws)!.push(message.type ?? 'unknown');
    if (message.type === 'SeatResumeChallenge') {
      ws.send(
        JSON.stringify({
          type: 'ResumeSeat',
          payload: {
            ...(proofOverride === null
              ? {}
              : {
                  resumeToken:
                    proofOverride ?? resumeTokens.get(ticketOwners.get(t)!),
                }),
          },
        }),
      );
    }
    if (message.type === 'SeatAuthenticated' && message.payload?.resumeToken) {
      const owner = ticketOwners.get(t);
      if (saveResumeToken && owner)
        resumeTokens.set(owner, message.payload.resumeToken);
    }
    if (message.type === 'StateSync' && acknowledgeStateSync)
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
  tokens = await Promise.all(
    accounts.map((id) => createSession(db, id, 'test')),
  );
  const room = await rooms.get(sessionId);
  for (let i = 0; i < accounts.length; i++) {
    const initialToken = await room.seat(
      accounts[i]!,
      `Player ${i}`,
      false,
      hashToken(tokens[i]!),
    );
    if (!initialToken) throw new Error('test seat has no resume token');
    resumeTokens.set(tokens[i]!, initialToken);
  }
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  base = address;
});
beforeEach(() => {
  connections.resetAuthAttemptHistory();
  vi.restoreAllMocks();
});
afterAll(async () => {
  await rooms.drain();
  await app.close();
  await db.end();
});
describe('gateway seat authentication limits', () => {
  it('refuses the sixth authentication attempt for one seat in a minute', () => {
    const key = `${sessionId}:${randomUUID()}`;
    for (let attempt = 0; attempt < 5; attempt++)
      expect(connections.consumeSeatAuthAttempt(key, 10_000)).toBe(true);
    expect(connections.consumeSeatAuthAttempt(key, 10_001)).toBe(false);
  });
});

describe('pending first-token handoff', () => {
  async function pendingSeat() {
    const id = randomUUID();
    await db.query('INSERT INTO sessions(id,owner_account_id) VALUES($1,$2)', [
      id,
      accounts[0],
    ]);
    const room = await rooms.get(id);
    const token = await room.seat(
      accounts[0]!,
      'Pending owner',
      false,
      hashToken(tokens[0]!),
    );
    if (!token) throw new Error('expected initial resume token');
    return { id, room, token };
  }

  function failSeatAuthenticatedSend(
    mode: 'callback' | 'throw',
    onAttempt?: (resumeToken: string) => void,
  ) {
    const original = WebSocket.prototype.send;
    const send = vi.spyOn(WebSocket.prototype, 'send');
    send.mockImplementation(function (
      this: WebSocket,
      data: WebSocket.RawData,
      options?: WebSocket.SendOptions | ((error?: Error) => void),
      callback?: (error?: Error) => void,
    ) {
      let message:
        | { type?: string; payload?: { resumeToken?: string } }
        | undefined;
      try {
        message = JSON.parse(String(data)) as {
          type?: string;
          payload?: { resumeToken?: string };
        };
      } catch {
        // Non-JSON websocket frames are passed through untouched.
      }
      if (message?.type === 'SeatAuthenticated') {
        if (message.payload?.resumeToken)
          onAttempt?.(message.payload.resumeToken);
        if (mode === 'throw')
          throw new Error('injected synchronous send failure');
        const done = typeof options === 'function' ? options : callback;
        done?.(new Error('injected callback send failure'));
        return this;
      }
      return original.call(this, data, options, callback);
    });
    return send;
  }

  it('rolls back a rotated token after the socket release handler already ran', async () => {
    const { id, token: previousToken } = await pendingSeat();
    const seatId = (await rooms.get(id)).state.seats[0]!.seatId;
    const socketId = randomUUID();
    const authorization = await authorizeSeatSocket(
      db,
      id,
      seatId,
      socketId,
      previousToken,
    );
    expect(authorization.status).toBe('authorized');
    if (authorization.status !== 'authorized') return;
    expect(
      await commitSeatResumeToken(
        db,
        id,
        seatId,
        socketId,
        authorization.resumeToken,
      ),
    ).toBe(true);
    await releaseSeatSocket(db, id, seatId, socketId);
    expect(
      await rollbackSeatResumeToken(
        db,
        id,
        seatId,
        socketId,
        authorization.resumeToken,
        authorization.previousTokenHash,
      ),
    ).toBe(true);
    const restored = await db.query<{ token_hash: string }>(
      'SELECT token_hash FROM seat_resume_tokens WHERE session_id=$1 AND seat_id=$2',
      [id, seatId],
    );
    expect(restored.rows[0]?.token_hash).toBe(
      createHash('sha256').update(previousToken).digest('hex'),
    );
  });

  it('does not restore a fenced T1 when a later T2 send fails', async () => {
    const { id, token: t1 } = await pendingSeat();
    const seatId = (await rooms.get(id)).state.seats[0]!.seatId;
    const t1SocketId = randomUUID();
    const first = await authorizeSeatSocket(db, id, seatId, t1SocketId, t1);
    expect(first.status).toBe('authorized');
    if (first.status !== 'authorized') return;
    expect(
      await commitSeatResumeToken(
        db,
        id,
        seatId,
        t1SocketId,
        first.resumeToken,
      ),
    ).toBe(true);
    clearSeatResumeTokenInvalidationPending(id, seatId);

    // Model failed rollback plus failed invalidation: T1 remains persisted but
    // is fenced in this process. A tokenless host-approved claim may recover.
    markSeatResumeTokenInvalidationPending(id, seatId);
    await db.query(
      `UPDATE seat_resume_tokens SET heartbeat_at=clock_timestamp()-interval '16 seconds'
        WHERE session_id=$1 AND seat_id=$2`,
      [id, seatId],
    );
    const t2SocketId = randomUUID();
    const second = await authorizeSeatSocket(
      db,
      id,
      seatId,
      t2SocketId,
      undefined,
      true,
      accounts[0],
    );
    expect(second.status).toBe('authorized');
    if (second.status !== 'authorized') return;
    expect(second.previousTokenHash).toBe(
      createHash('sha256').update(first.resumeToken).digest('hex'),
    );
    expect(
      await commitSeatResumeToken(
        db,
        id,
        seatId,
        t2SocketId,
        second.resumeToken,
      ),
    ).toBe(true);

    // This rollback is the real post-send-failure path. While the fence is
    // pending it must not put the previously stranded T1 hash back in storage.
    expect(
      await rollbackSeatResumeToken(
        db,
        id,
        seatId,
        t2SocketId,
        second.resumeToken,
        second.previousTokenHash,
      ),
    ).toBe(true);
    await releaseSeatSocket(db, id, seatId, t2SocketId);
    const persisted = await db.query<{ token_hash: string }>(
      'SELECT token_hash FROM seat_resume_tokens WHERE session_id=$1 AND seat_id=$2',
      [id, seatId],
    );
    expect(persisted.rows[0]?.token_hash).not.toBe(
      createHash('sha256').update(first.resumeToken).digest('hex'),
    );
    for (const token of [first.resumeToken, second.resumeToken]) {
      expect(
        await authorizeSeatSocket(db, id, seatId, randomUUID(), token),
      ).toEqual({ status: 'invalid-token' });
    }
    clearSeatResumeTokenInvalidationPending(id, seatId);
  });

  it('does not invalidate a token after another socket takes over its lease', async () => {
    const { id, token } = await pendingSeat();
    const seatId = (await rooms.get(id)).state.seats[0]!.seatId;
    const owner = randomUUID();
    const authorization = await authorizeSeatSocket(
      db,
      id,
      seatId,
      owner,
      token,
    );
    expect(authorization.status).toBe('authorized');
    if (authorization.status !== 'authorized') return;
    expect(
      await commitSeatResumeToken(
        db,
        id,
        seatId,
        owner,
        authorization.resumeToken,
      ),
    ).toBe(true);
    await db.query(
      'UPDATE seat_resume_tokens SET active_socket_id=$3 WHERE session_id=$1 AND seat_id=$2',
      [id, seatId, randomUUID()],
    );
    expect(
      await invalidateSeatResumeToken(
        db,
        id,
        seatId,
        owner,
        authorization.resumeToken,
      ),
    ).toBe(false);
  });

  it('revokes an undelivered pending credential after rollback retries fail', async () => {
    const { id } = await pendingSeat();
    let undeliveredToken: string | undefined;
    const room = await rooms.get(id);
    const seatId = room.state.seats[0]!.seatId;
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    const rollback = vi
      .spyOn(resumeTokenModule, 'rollbackSeatResumeToken')
      .mockRejectedValue(new Error('injected rollback DB failure'));
    const failSend = failSeatAuthenticatedSend(
      'callback',
      (token) => (undeliveredToken = token),
    );
    const before = capturedLogs.length;
    try {
      const failed = connect(await ticket(tokens[0]!, id), null, false);
      expect(await closed(failed)).toBe(1011);
      await waitForReleasedSocket(seatId, id);
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(unhandled).toEqual([]);
      expect(rollback).toHaveBeenCalledTimes(2);
      expect(undeliveredToken).toEqual(expect.any(String));
      failSend.mockRestore();

      const retry = connect(await ticket(tokens[0]!, id), null, false);
      const pending = await nextOfType(retry, 'SeatClaimPending', 1_500);
      expect(pending.payload.claimId).toEqual(expect.any(String));
      expect(seenMessageTypes.get(retry)).not.toContain('SeatAuthenticated');
      await closeSocket(retry);

      const logs = capturedLogs.slice(before).join('\n');
      expect(logs).toContain('seat.resume_token.rollback_failed');
      expect(logs).toContain('"attempt":1');
      expect(logs).toContain('"attempt":2');
      expect(logs).not.toContain(undeliveredToken);
      expect(logs).not.toContain('injected rollback DB failure');

      const replay = connect(
        await ticket(tokens[0]!, id),
        undeliveredToken!,
        false,
      );
      try {
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(seenMessageTypes.get(replay)).not.toContain('SeatAuthenticated');
      } finally {
        await closeSocket(replay);
      }
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
      failSend.mockRestore();
      rollback.mockRestore();
    }
  }, 20_000);

  it('keeps T1 fenced when a stale invalidation races with takeover rollback', async () => {
    const { id } = await pendingSeat();
    const seatId = (await rooms.get(id)).state.seats[0]!.seatId;
    let t1: string | undefined;
    let takeover:
      | { socketId: string; resumeToken: string; previousTokenHash: string }
      | undefined;
    const rollback = vi
      .spyOn(resumeTokenModule, 'rollbackSeatResumeToken')
      .mockRejectedValue(new Error('injected rollback DB failure'));
    const invalidate = vi
      .spyOn(resumeTokenModule, 'invalidateSeatResumeToken')
      .mockImplementation(
        async (_db, sessionId, claimedSeatId, oldSocketId) => {
          // Model a lease released during the failed rollback window, followed by
          // a host-approved takeover that commits T2 before A's stale CAS returns.
          await releaseSeatSocket(db, sessionId, claimedSeatId, oldSocketId);
          const socketId = randomUUID();
          const reserved = await authorizeSeatSocket(
            db,
            sessionId,
            claimedSeatId,
            socketId,
            undefined,
            true,
            accounts[0],
          );
          expect(reserved.status).toBe('authorized');
          if (reserved.status !== 'authorized') return false;
          expect(reserved.previousTokenHash).toBe(
            createHash('sha256').update(t1!).digest('hex'),
          );
          expect(
            await commitSeatResumeToken(
              db,
              sessionId,
              claimedSeatId,
              socketId,
              reserved.resumeToken,
            ),
          ).toBe(true);
          takeover = {
            socketId,
            resumeToken: reserved.resumeToken,
            previousTokenHash: reserved.previousTokenHash,
          };
          return true;
        },
      );
    const failSend = failSeatAuthenticatedSend('callback', (token) => {
      t1 = token;
    });
    try {
      const failed = connect(await ticket(tokens[0]!, id), null, false);
      expect(await closed(failed)).toBe(1011);
      expect(t1).toEqual(expect.any(String));
      expect(takeover).toBeDefined();
      expect(rollback).toHaveBeenCalledTimes(2);

      rollback.mockRestore();
      invalidate.mockRestore();
      const second = takeover!;
      expect(
        await rollbackSeatResumeToken(
          db,
          id,
          seatId,
          second.socketId,
          second.resumeToken,
          second.previousTokenHash,
        ),
      ).toBe(true);
      await releaseSeatSocket(db, id, seatId, second.socketId);
      expect(
        await authorizeSeatSocket(db, id, seatId, randomUUID(), t1),
      ).toEqual({ status: 'invalid-token' });
    } finally {
      failSend.mockRestore();
      rollback.mockRestore();
      invalidate.mockRestore();
      clearSeatResumeTokenInvalidationPending(id, seatId);
    }
  }, 20_000);

  it('retains the lease and fences a token while invalidation remains unresolved', async () => {
    const { id } = await pendingSeat();
    const seatId = (await rooms.get(id)).state.seats[0]!.seatId;
    let undeliveredToken: string | undefined;
    const rollback = vi
      .spyOn(resumeTokenModule, 'rollbackSeatResumeToken')
      .mockRejectedValue(new Error('injected rollback DB failure'));
    const invalidate = vi
      .spyOn(resumeTokenModule, 'invalidateSeatResumeToken')
      .mockRejectedValue(new Error('injected invalidation DB failure'));
    const failSend = failSeatAuthenticatedSend(
      'callback',
      (token) => (undeliveredToken = token),
    );
    const before = capturedLogs.length;
    try {
      const failed = connect(await ticket(tokens[0]!, id), null, false);
      expect(await closed(failed)).toBe(1011);
      expect(undeliveredToken).toEqual(expect.any(String));
      await new Promise((resolve) => setTimeout(resolve, 50));

      const row = await db.query<{
        token_hash: string;
        active_socket_id: string | null;
      }>(
        'SELECT token_hash,active_socket_id FROM seat_resume_tokens WHERE session_id=$1 AND seat_id=$2',
        [id, seatId],
      );
      expect(row.rows[0]?.active_socket_id).toEqual(expect.any(String));
      expect(row.rows[0]?.token_hash).toBe(
        createHash('sha256').update(undeliveredToken!).digest('hex'),
      );
      expect(rollback).toHaveBeenCalledTimes(2);
      expect(invalidate).toHaveBeenCalledTimes(2);

      await db.query(
        `UPDATE seat_resume_tokens SET heartbeat_at=clock_timestamp()-interval '16 seconds'
          WHERE session_id=$1 AND seat_id=$2`,
        [id, seatId],
      );
      expect(
        await authorizeSeatSocket(
          db,
          id,
          seatId,
          randomUUID(),
          undeliveredToken,
        ),
      ).toEqual({ status: 'invalid-token' });
      expect(
        await authorizeSeatSocket(
          db,
          id,
          seatId,
          randomUUID(),
          undeliveredToken,
          true,
          accounts[0],
        ),
      ).toEqual({ status: 'invalid-token' });

      const hostApprovalRetry = connect(
        await ticket(tokens[0]!, id),
        null,
        false,
      );
      try {
        await nextOfType(hostApprovalRetry, 'SeatClaimPending', 1_500);
        expect(seenMessageTypes.get(hostApprovalRetry)).not.toContain(
          'SeatAuthenticated',
        );
      } finally {
        await closeSocket(hostApprovalRetry);
      }

      const logs = capturedLogs.slice(before);
      const invalidationLog = logs.find((line) =>
        line.includes('seat.resume_token.invalidation_failed'),
      );
      expect(invalidationLog).toContain(
        'seat.resume_token.invalidation_failed',
      );
      expect(invalidationLog).not.toContain(undeliveredToken);
      expect(invalidationLog).not.toContain(
        createHash('sha256').update(undeliveredToken!).digest('hex'),
      );
      expect(invalidationLog).not.toContain('"attempt"');
    } finally {
      failSend.mockRestore();
      rollback.mockRestore();
      invalidate.mockRestore();
      clearSeatResumeTokenInvalidationPending(id, seatId);
    }
  }, 20_000);

  it('retains the lease when the socket closes during rollback retry delay', async () => {
    const { id, token: t1 } = await pendingSeat();
    const seatId = (await rooms.get(id)).state.seats[0]!.seatId;
    let t2: string | undefined;
    let failedSocket: WebSocket | undefined;
    let closedDuringRetryDelay = false;
    const rollback = vi
      .spyOn(resumeTokenModule, 'rollbackSeatResumeToken')
      .mockRejectedValue(new Error('injected rollback DB failure'));
    const invalidate = vi
      .spyOn(resumeTokenModule, 'invalidateSeatResumeToken')
      .mockRejectedValue(new Error('injected invalidation DB failure'));
    const originalSetTimeout = globalThis.setTimeout;
    const delay = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      handler: TimerHandler,
      timeout?: number,
      ...args: unknown[]
    ) => {
      if (
        timeout === 20 &&
        rollback.mock.calls.length === 1 &&
        failedSocket &&
        failedSocket.readyState === WebSocket.OPEN
      ) {
        closedDuringRetryDelay = true;
        void closeSocket(failedSocket);
      }
      return originalSetTimeout(handler, timeout, ...args);
    }) as typeof setTimeout);
    const failSend = failSeatAuthenticatedSend('callback', (token) => {
      t2 = token;
    });
    try {
      failedSocket = connect(await ticket(tokens[0]!, id), null, false);
      await closed(failedSocket);
      expect(closedDuringRetryDelay).toBe(true);
      expect(t2).toEqual(expect.any(String));
      await new Promise((resolve) => originalSetTimeout(resolve, 60));

      const row = await db.query<{ active_socket_id: string | null }>(
        'SELECT active_socket_id FROM seat_resume_tokens WHERE session_id=$1 AND seat_id=$2',
        [id, seatId],
      );
      expect(row.rows[0]?.active_socket_id).toEqual(expect.any(String));
      expect(rollback).toHaveBeenCalledTimes(2);
      for (const token of [t1, t2!]) {
        expect(
          await authorizeSeatSocket(db, id, seatId, randomUUID(), token),
        ).toEqual({ status: 'invalid-token' });
      }
    } finally {
      failSend.mockRestore();
      delay.mockRestore();
      rollback.mockRestore();
      invalidate.mockRestore();
      clearSeatResumeTokenInvalidationPending(id, seatId);
    }
  }, 20_000);

  it('restores a presented resume token after SeatAuthenticated send failure', async () => {
    const { id } = await pendingSeat();
    const first = connect(await ticket(tokens[0]!, id), null, false);
    const previousToken = String(
      (await nextOfType(first, 'SeatAuthenticated')).payload.resumeToken,
    );
    await closeSocket(first);
    const seatId = (await rooms.get(id)).state.seats[0]!.seatId;
    const failSend = failSeatAuthenticatedSend('callback');
    const failed = connect(await ticket(tokens[0]!, id), previousToken, false);
    expect(await closed(failed)).toBe(1011);
    await waitForReleasedSocket(seatId, id);
    failSend.mockRestore();
    const retry = connect(await ticket(tokens[0]!, id), previousToken, false);
    expect(
      (await nextOfType(retry, 'SeatAuthenticated', 1_500)).payload.resumeToken,
    ).toEqual(expect.any(String));
    await closeSocket(retry);
  }, 20_000);

  it.each(['callback', 'throw'] as const)(
    'restores the pending credential after a %s send failure so a tokenless retry can receive it',
    async (mode) => {
      const { id } = await pendingSeat();
      const seatId = (await rooms.get(id)).state.seats[0]!.seatId;
      const failSend = failSeatAuthenticatedSend(mode);
      const failed = connect(await ticket(tokens[0]!, id), null, false);
      expect(await closed(failed)).toBe(1011);
      await waitForReleasedSocket(seatId, id);

      failSend.mockRestore();
      const retry = connect(await ticket(tokens[0]!, id), null, false);
      expect(
        (await nextOfType(retry, 'SeatAuthenticated', 1_500)).payload
          .resumeToken,
      ).toEqual(expect.any(String));
      await closeSocket(retry);
    },
    20_000,
  );

  it('does not let a concurrent tokenless socket obtain the pending credential while send rollback is pending', async () => {
    const { id } = await pendingSeat();
    const seatId = (await rooms.get(id)).state.seats[0]!.seatId;
    let sendStarted!: () => void;
    let finishSend!: (error?: Error) => void;
    const started = new Promise<void>((resolve) => (sendStarted = resolve));
    const original = WebSocket.prototype.send;
    const failSend = vi.spyOn(WebSocket.prototype, 'send');
    failSend.mockImplementation(function (
      this: WebSocket,
      data: WebSocket.RawData,
      options?: WebSocket.SendOptions | ((error?: Error) => void),
      callback?: (error?: Error) => void,
    ) {
      if (JSON.parse(String(data)).type === 'SeatAuthenticated') {
        const done = typeof options === 'function' ? options : callback;
        sendStarted();
        finishSend = (error) => done?.(error);
        return this;
      }
      return original.call(this, data, options, callback);
    });
    const first = connect(await ticket(tokens[0]!, id), null, false);
    await started;
    const second = connect(await ticket(tokens[0]!, id), null, false);
    expect(await closed(second)).toBe(1008);
    finishSend(new Error('injected callback send failure'));
    expect(await closed(first)).toBe(1011);
    await waitForReleasedSocket(seatId, id);
    failSend.mockRestore();

    const retry = connect(await ticket(tokens[0]!, id), null, false);
    expect(
      (await nextOfType(retry, 'SeatAuthenticated', 1_500)).payload.resumeToken,
    ).toEqual(expect.any(String));
    await closeSocket(retry);
  }, 20_000);

  it('delivers only to the exact authenticated session, once', async () => {
    const { room, token } = await pendingSeat();
    expect(
      room.claimPendingSeatResumeToken(
        accounts[0]!,
        hashToken(tokens[1]!),
        randomUUID(),
      ),
    ).toBeUndefined();
    expect(
      room.claimPendingSeatResumeToken(
        accounts[0]!,
        hashToken(tokens[0]!),
        'lease-one',
      ),
    ).toBe(token);
    expect(
      room.claimPendingSeatResumeToken(
        accounts[0]!,
        hashToken(tokens[0]!),
        'lease-two',
      ),
    ).toBeUndefined();
  });

  it('releases a pending-token lease for retry and prevents concurrent reuse', async () => {
    const { room, token } = await pendingSeat();
    const firstLease = 'lease-first';
    const concurrentLease = 'lease-concurrent';
    expect(
      room.claimPendingSeatResumeToken(
        accounts[0]!,
        hashToken(tokens[0]!),
        firstLease,
      ),
    ).toBe(token);
    expect(
      room.claimPendingSeatResumeToken(
        accounts[0]!,
        hashToken(tokens[0]!),
        concurrentLease,
      ),
    ).toBeUndefined();
    room.completeSeatResumeTokenDelivery(accounts[0]!, hashToken(tokens[0]!));
    expect(
      room.claimPendingSeatResumeToken(
        accounts[0]!,
        hashToken(tokens[0]!),
        concurrentLease,
      ),
    ).toBeUndefined();
    room.releasePendingSeatResumeToken(
      accounts[0]!,
      hashToken(tokens[0]!),
      firstLease,
    );
    expect(
      room.claimPendingSeatResumeToken(
        accounts[0]!,
        hashToken(tokens[0]!),
        concurrentLease,
      ),
    ).toBe(token);
    room.completeSeatResumeTokenDelivery(
      accounts[0]!,
      hashToken(tokens[0]!),
      concurrentLease,
    );
    expect(
      room.claimPendingSeatResumeToken(
        accounts[0]!,
        hashToken(tokens[0]!),
        'replay',
      ),
    ).toBeUndefined();
  });

  it('expires a lease independently before the pending token expires', async () => {
    const { room, token } = await pendingSeat();
    const now = Date.now();
    expect(
      room.claimPendingSeatResumeToken(
        accounts[0]!,
        hashToken(tokens[0]!),
        'short-lease',
        now,
      ),
    ).toBe(token);
    expect(
      room.claimPendingSeatResumeToken(
        accounts[0]!,
        hashToken(tokens[0]!),
        'lease-after-timeout',
        now + 15_001,
      ),
    ).toBe(token);
    room.releasePendingSeatResumeToken(
      accounts[0]!,
      hashToken(tokens[0]!),
      'lease-after-timeout',
    );
  });

  it('does not deliver an expired pending token', async () => {
    const { room } = await pendingSeat();
    expect(
      room.claimPendingSeatResumeToken(
        accounts[0]!,
        hashToken(tokens[0]!),
        randomUUID(),
        Date.now() + 30_001,
      ),
    ).toBeUndefined();
  });

  it('logs and closes when authorization throws after claiming the pending token', async () => {
    const { id } = await pendingSeat();
    const spy = vi.spyOn(resumeTokenModule, 'authorizeSeatSocket');
    spy.mockRejectedValueOnce(new Error('injected authorization failure'));
    const before = capturedLogs.length;
    const socket = connect(await ticket(tokens[0]!, id), null);
    const closeResult = new Promise<{ code: number; reason: string }>(
      (resolve) =>
        socket.once('close', (code, reason) =>
          resolve({ code, reason: reason.toString() }),
        ),
    );
    expect(await closeResult).toEqual({
      code: 1008,
      reason: 'Policy violation',
    });
    const entries = capturedLogs.slice(before).map((line) => JSON.parse(line));
    expect(entries).toContainEqual(
      expect.objectContaining({
        event: 'seat.socket.refused',
        reason: 'authorization-error',
        step: 'authorization',
        sessionId: id,
        pendingTokenClaimed: true,
        closeCode: null,
      }),
    );
    expect(
      entries.find((entry) => entry.event === 'seat.socket.refused'),
    ).not.toHaveProperty('socketId');
    spy.mockRestore();
  });

  it('allows a retry after pending-token authorization is refused', async () => {
    const { id } = await pendingSeat();
    const spy = vi.spyOn(resumeTokenModule, 'authorizeSeatSocket');
    spy.mockRejectedValueOnce(new Error('injected authorization failure'));
    const refused = connect(await ticket(tokens[0]!, id), null);
    expect(await closed(refused)).toBe(1008);

    const retry = connect(await ticket(tokens[0]!, id), null);
    const authenticated = await nextOfType(retry, 'SeatAuthenticated');
    expect(authenticated.type).toBe('SeatAuthenticated');
    await closeSocket(retry);
    spy.mockRestore();
  });

  it('consumes the pending credential when completion throws after authentication', async () => {
    const { id, room } = await pendingSeat();
    const completion = vi
      .spyOn(room, 'completeSeatResumeTokenDelivery')
      .mockImplementation(() => {
        throw new Error('injected delivery completion failure');
      });
    const before = capturedLogs.length;
    const socket = connect(await ticket(tokens[0]!, id), null);
    const closePromise = new Promise<{ code: number; reason: string }>(
      (resolve) =>
        socket.once('close', (code, reason) =>
          resolve({ code, reason: reason.toString() }),
        ),
    );
    expect((await nextOfType(socket, 'SeatAuthenticated')).type).toBe(
      'SeatAuthenticated',
    );
    const closeResult = await closePromise;
    expect(closeResult).toEqual({ code: 1008, reason: 'Policy violation' });
    const event = capturedLogs
      .slice(before)
      .map((line) => JSON.parse(line))
      .find((line) => line.event === 'seat.socket.refused');
    expect(event).toMatchObject({
      event: 'seat.socket.refused',
      reason: 'post-claim-error',
      step: 'delivery-completion',
      sessionId: id,
      pendingTokenClaimed: true,
      closeCode: null,
    });
    expect(
      room.claimPendingSeatResumeToken(
        accounts[0]!,
        hashToken(tokens[0]!),
        'replay-after-delivered-completion-failure',
      ),
    ).toBeUndefined();
    completion.mockRestore();
  });

  it('logs not-seated refusal after a pending-token claim', async () => {
    const { id, room } = await pendingSeat();
    const seats = room.state.seats;
    room.state = {
      ...room.state,
      seats: seats.filter((seat) => seat.accountId !== accounts[0]),
    };
    const spy = vi.spyOn(resumeTokenModule, 'authorizeSeatSocket');
    spy.mockResolvedValueOnce({ status: 'invalid-token' });
    const before = capturedLogs.length;
    const socket = connect(await ticket(tokens[0]!, id), null);
    expect(await closed(socket)).toBe(1008);
    const entry = capturedLogs
      .slice(before)
      .map((line) => JSON.parse(line))
      .find((line) => line.event === 'seat.socket.refused');
    expect(entry).toMatchObject({
      event: 'seat.socket.refused',
      reason: 'not-seated',
      sessionId: id,
      pendingTokenClaimed: true,
      closeCode: 1008,
    });
    spy.mockRestore();
  });

  it('logs reservation-unavailable after closing and releasing the authorized socket', async () => {
    const { id, room } = await pendingSeat();
    const seatId = room.state.seats.find(
      (seat) => seat.accountId === accounts[0],
    )!.seatId;
    const blocker = { readyState: 0 } as WebSocket;
    const seatKey = `${id}:${seatId}`;
    expect(connections.reserveSeat(seatKey, blocker)).toMatchObject({
      reserved: true,
    });
    const before = capturedLogs.length;
    const socket = connect(await ticket(tokens[0]!, id), null);
    expect(await closed(socket)).toBe(1008);
    connections.remove(blocker);
    const entry = await (async () => {
      for (let attempt = 0; attempt < 50; attempt++) {
        const match = capturedLogs
          .slice(before)
          .map((line) => JSON.parse(line))
          .find((line) => line.event === 'seat.socket.refused');
        if (match) return match;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return undefined;
    })();
    expect(entry).toMatchObject({
      event: 'seat.socket.refused',
      reason: 'reservation-unavailable',
      sessionId: id,
      pendingTokenClaimed: true,
      closeCode: 1008,
    });
  });

  it('logs an active-socket refusal after claiming the pending token', async () => {
    const { id, room } = await pendingSeat();
    const seatId = room.state.seats.find(
      (seat) => seat.accountId === accounts[0],
    )!.seatId;
    await db.query(
      `UPDATE seat_resume_tokens SET active_socket_id=$3,heartbeat_at=now()
        WHERE session_id=$1 AND seat_id=$2`,
      [id, seatId, randomUUID()],
    );
    const before = capturedLogs.length;
    const socket = connect(await ticket(tokens[0]!, id), null);
    const closeCode = await closed(socket);
    expect(closeCode).toBe(1008);
    const log = await (async () => {
      for (let i = 0; i < 50; i++) {
        const match = capturedLogs
          .slice(before)
          .map((line) => JSON.parse(line))
          .find((entry) => entry.event === 'seat.socket.refused');
        if (match) return match;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error('seat.socket.refused was not logged');
    })();
    expect(log).toMatchObject({
      event: 'seat.socket.refused',
      reason: 'authorization-active-socket',
      seatId,
      sessionId: id,
      pendingTokenClaimed: true,
      closeCode: 1008,
    });
    expect(log).toHaveProperty('socketAgeMs');
    await db.query(
      'UPDATE seat_resume_tokens SET active_socket_id=NULL,heartbeat_at=NULL WHERE session_id=$1 AND seat_id=$2',
      [id, seatId],
    );
  });
});

describe('one-time gateway', () => {
  it('allows the required late-join snapshot ack after an ack flood', async () => {
    const id = randomUUID();
    const priorHostToken = resumeTokens.get(tokens[0]!);
    const priorGuestToken = resumeTokens.get(tokens[1]!);
    await db.query('INSERT INTO sessions(id,owner_account_id) VALUES($1,$2)', [
      id,
      accounts[0],
    ]);
    const room = await rooms.get(id);
    const hostToken = await room.seat(
      accounts[0]!,
      'Late-join host',
      false,
      hashToken(tokens[0]!),
    );
    if (!hostToken) throw new Error('late-join host has no resume token');
    resumeTokens.set(tokens[0]!, hostToken);
    const host = connect(await ticket(tokens[0]!, id));
    let guest: WebSocket | undefined;
    try {
      await nextOfType(host, 'StateSync');
      const character = {
        ...quickBuild(loadCatalog(), undefined, 0x73, 1).character,
        id: randomUUID(),
      };
      const guestRevision = await new SeatCharacterRepository(
        db,
      ).saveOwnedCharacter(accounts[1]!, character);
      const requestId = await room.requestLateJoin(
        accounts[1]!,
        character.id,
        guestRevision,
        randomUUID(),
        'Late-join guest',
      );
      await room.approveLateJoin(accounts[0]!, randomUUID(), requestId);
      await (
        room as unknown as { admitApprovedLateJoins(): Promise<void> }
      ).admitApprovedLateJoins();
      const guestSeat = room.state.seats.find(
        (seat) => seat.accountId === accounts[1],
      )!;
      const guestResumeToken = randomUUID();
      const acknowledgeSnapshot = vi.spyOn(room, 'acknowledgeLateJoinSnapshot');
      await db.query(
        'UPDATE seat_resume_tokens SET token_hash=$3 WHERE session_id=$1 AND seat_id=$2',
        [id, guestSeat.seatId, hashToken(guestResumeToken)],
      );
      resumeTokens.set(tokens[1]!, guestResumeToken);
      guest = connect(
        await ticket(tokens[1]!, id),
        undefined,
        true,
        undefined,
        base,
        false,
      );
      const snapshot = await nextOfType(guest, 'StateSync');
      for (let index = 0; index < 21; index++) {
        guest.send(
          JSON.stringify({
            actionId: randomUUID(),
            type: 'StateSyncAck',
            payload: { seq: snapshot.seq - 1 },
            lastSeq: snapshot.seq,
          }),
        );
      }
      guest.send(
        JSON.stringify({
          actionId: randomUUID(),
          type: 'StateSyncAck',
          payload: { seq: snapshot.seq },
          lastSeq: snapshot.seq,
        }),
      );
      for (let attempt = 0; attempt < 50; attempt++) {
        if (acknowledgeSnapshot.mock.calls.length > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(acknowledgeSnapshot).toHaveBeenCalledWith(
        accounts[1],
        guestSeat.seatId,
        snapshot.seq,
      );
    } finally {
      await Promise.all([
        closeSocket(host),
        ...(guest ? [closeSocket(guest)] : []),
      ]);
      if (priorHostToken) resumeTokens.set(tokens[0]!, priorHostToken);
      else resumeTokens.delete(tokens[0]!);
      if (priorGuestToken) resumeTokens.set(tokens[1]!, priorGuestToken);
      else resumeTokens.delete(tokens[1]!);
      await rooms.evictSession(id);
    }
  }, 30_000);

  it('charges ChatSend and StateSyncAck to the per-socket message budget', async () => {
    const id = randomUUID();
    await db.query('INSERT INTO sessions(id,owner_account_id) VALUES($1,$2)', [
      id,
      accounts[0],
    ]);
    const room = await rooms.get(id);
    const priorToken0 = resumeTokens.get(tokens[0]!);
    const priorToken1 = resumeTokens.get(tokens[1]!);
    const initialToken = await room.seat(
      accounts[0]!,
      'Rate-limit player',
      false,
      hashToken(tokens[0]!),
    );
    if (!initialToken) throw new Error('rate-limit seat has no resume token');
    resumeTokens.set(tokens[0]!, initialToken);
    const secondInitialToken = await room.seat(
      accounts[1]!,
      'Second rate-limit player',
      false,
      hashToken(tokens[1]!),
    );
    if (!secondInitialToken)
      throw new Error('second rate-limit seat has no resume token');
    resumeTokens.set(tokens[1]!, secondInitialToken);
    const chatSocket = connect(await ticket(tokens[0]!, id));
    const ackSocket = connect(await ticket(tokens[1]!, id));
    try {
      const chatState = await nextOfType(chatSocket, 'StateSync');
      await nextOfType(ackSocket, 'StateSync');
      for (let index = 0; index < 24; index++) {
        chatSocket.send(
          JSON.stringify({
            actionId: randomUUID(),
            type: 'ChatSend',
            payload: { text: `budget probe ${index}` },
            lastSeq: chatState.seq,
          }),
        );
        ackSocket.send(
          JSON.stringify({
            actionId: randomUUID(),
            type: 'StateSyncAck',
            payload: { seq: chatState.seq },
            lastSeq: chatState.seq,
          }),
        );
      }
      const waitForRateLimit = async (ws: WebSocket) => {
        for (let index = 0; index < 40; index++) {
          const message = await next(ws);
          if (
            message.type === 'Error' &&
            message.payload.code === 'RATE_LIMITED'
          )
            return message;
        }
        throw new Error('message budget was not enforced');
      };
      await expect(waitForRateLimit(chatSocket)).resolves.toMatchObject({
        payload: { code: 'RATE_LIMITED' },
      });
      await expect(waitForRateLimit(ackSocket)).resolves.toMatchObject({
        payload: { code: 'RATE_LIMITED' },
      });
    } finally {
      await Promise.all([closeSocket(chatSocket), closeSocket(ackSocket)]);
      if (priorToken0) resumeTokens.set(tokens[0]!, priorToken0);
      else resumeTokens.delete(tokens[0]!);
      if (priorToken1) resumeTokens.set(tokens[1]!, priorToken1);
      else resumeTokens.delete(tokens[1]!);
    }
  }, 30_000);
  it('serializes solo recovery behind a concurrent seat join', async () => {
    const id = randomUUID();
    await db.query(
      "INSERT INTO sessions(id,owner_account_id,mode) VALUES($1,$2,'solo')",
      [id, accounts[0]],
    );
    const room = await rooms.get(id);
    await room.seat(accounts[0]!, 'Solo owner');
    const ownerSeatId = room.state.seats.find(
      (seat) => seat.accountId === accounts[0],
    )!.seatId;
    const joiningClient = await db.connect();
    try {
      await joiningClient.query('BEGIN');
      await joiningClient.query(
        'SELECT id FROM sessions WHERE id=$1 FOR UPDATE',
        [id],
      );
      const seq = Number(
        (
          await joiningClient.query<{ seq: string }>(
            'SELECT COALESCE(MAX(seq),0)::text AS seq FROM events WHERE session_id=$1',
            [id],
          )
        ).rows[0]!.seq,
      );
      const secondSeatId = randomUUID();
      await joiningClient.query(
        `INSERT INTO events(session_id,seq,turn_id,type,payload)
         VALUES($1,$2,$3,'SeatJoined',$4::jsonb)`,
        [
          id,
          seq + 1,
          randomUUID(),
          JSON.stringify({ seatId: secondSeatId, accountId: accounts[1] }),
        ],
      );

      let settled = false;
      const recovery = authorizeSeatSocket(
        db,
        id,
        ownerSeatId,
        randomUUID(),
        undefined,
        false,
        accounts[0],
        true,
      ).then((result) => {
        settled = true;
        return result;
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(settled).toBe(false);
      await joiningClient.query('COMMIT');
      expect(await recovery).toEqual({ status: 'invalid-token' });
    } finally {
      await joiningClient.query('ROLLBACK').catch(() => undefined);
      joiningClient.release();
    }
  });

  it('refuses solo recovery when a second current seat exists', async () => {
    const id = randomUUID();
    await db.query(
      "INSERT INTO sessions(id,owner_account_id,mode) VALUES($1,$2,'solo')",
      [id, accounts[0]],
    );
    const room = await rooms.get(id);
    await room.seat(accounts[0]!, 'Solo owner');
    await room.seat(accounts[1]!, 'Unexpected second seat');
    const ownerSeatId = room.state.seats.find(
      (seat) => seat.accountId === accounts[0],
    )!.seatId;
    const secondSeatId = room.state.seats.find(
      (seat) => seat.accountId === accounts[1],
    )!.seatId;
    expect(
      await authorizeSeatSocket(
        db,
        id,
        ownerSeatId,
        randomUUID(),
        undefined,
        false,
        accounts[0],
        true,
      ),
    ).toEqual({ status: 'invalid-token' });
    const recoveryTicket = await issueTicket(
      db,
      accounts[0]!,
      id,
      hashToken(tokens[0]!),
    );
    expect(
      await soloOwnerRecoveryTicket(db, recoveryTicket, id),
    ).toBeUndefined();

    await room.kickSeat(accounts[0]!, randomUUID(), secondSeatId);
    const recoverySocketId = randomUUID();
    const recovered = await authorizeSeatSocket(
      db,
      id,
      ownerSeatId,
      recoverySocketId,
      undefined,
      false,
      accounts[0],
      true,
    );
    expect(recovered).toMatchObject({
      status: 'authorized',
      soloOwnerRecovery: true,
    });
    expect(await soloOwnerRecoveryTicket(db, recoveryTicket, id)).toMatchObject(
      {
        accountId: accounts[0],
        sessionId: id,
        seatId: ownerSeatId,
      },
    );
    if (recovered.status === 'authorized')
      await releaseSeatSocket(db, id, ownerSeatId, recoverySocketId);
  });

  it('throttles the sixth wrong-cookie solo recovery precheck within one minute', async () => {
    const id = randomUUID();
    await db.query(
      "INSERT INTO sessions(id,owner_account_id,mode) VALUES($1,$2,'solo')",
      [id, accounts[0]],
    );
    const room = await rooms.get(id);
    const seatToken = await room.seat(accounts[0]!, 'Rate-limited owner');
    expect(seatToken).toBeTruthy();
    const seatId = room.state.seats.find(
      (seat) => seat.accountId === accounts[0],
    )!.seatId;
    for (let attempt = 0; attempt < 6; attempt++) {
      const wrongCookieSocket = connect(
        await ticket(tokens[0]!, id),
        undefined,
        false,
        tokens[1]!,
      );
      expect(await closed(wrongCookieSocket)).toBe(1008);
    }
    expect(connections.consumeSeatAuthAttempt(`${id}:${seatId}`)).toBe(false);
    const unused = await db.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM ws_tickets WHERE session_id=$1 AND used_at IS NULL',
      [id],
    );
    expect(Number(unused.rows[0]?.count)).toBe(6);
  });

  it('keeps solo recovery off by default and permits it only when explicitly enabled', async () => {
    const priorResumeToken = resumeTokens.get(tokens[0]!);
    const otherSessionId = randomUUID();
    await db.query('INSERT INTO sessions(id,owner_account_id) VALUES($1,$2)', [
      otherSessionId,
      accounts[0],
    ]);
    const otherRoom = await rooms.get(otherSessionId);
    const otherInitialToken = await otherRoom.seat(
      accounts[0]!,
      'Other device',
    );
    resumeTokens.set(tokens[0]!, otherInitialToken!);
    const otherSessionSocket = connect(
      await ticket(tokens[0]!, otherSessionId),
    );
    await nextOfType(otherSessionSocket, 'StateSync');
    const soloSessionId = randomUUID();
    await db.query(
      "INSERT INTO sessions(id,owner_account_id,mode) VALUES($1,$2,'solo')",
      [soloSessionId, accounts[0]],
    );
    const room = await rooms.get(soloSessionId);
    const initialToken = await room.seat(accounts[0], 'Solo owner');
    expect(initialToken).toBeTruthy();
    const seatId = room.state.seats.find(
      (seat) => seat.accountId === accounts[0],
    )!.seatId;
    resumeTokens.set(tokens[0]!, initialToken!);
    room.completeSeatResumeTokenDelivery(accounts[0]!, hashToken(tokens[0]!));

    expect(
      await authorizeSeatSocket(
        db,
        soloSessionId,
        seatId,
        randomUUID(),
        undefined,
        false,
        accounts[0],
        false,
      ),
    ).toEqual({ status: 'invalid-token' });
    expect(
      await authorizeSeatSocket(
        db,
        soloSessionId,
        randomUUID(),
        randomUUID(),
        undefined,
        false,
        accounts[0],
        true,
      ),
    ).toEqual({ status: 'invalid-token' });

    const live = connect(await ticket(tokens[0]!, soloSessionId));
    await nextOfType(live, 'SeatAuthenticated');
    await nextOfType(live, 'StateSync');
    const deniedWhileLive = connect(
      await ticket(tokens[0]!, soloSessionId),
      null,
      false,
    );
    expect(await closed(deniedWhileLive)).toBe(1008);
    expect(live.readyState).toBe(WebSocket.OPEN);
    await closeSocket(live);
    await waitForReleasedSocket(seatId, soloSessionId);

    // A stale token is recoverable for the verified solo owner, without a host.
    const staleTokenSocket = connect(
      await ticket(tokens[0]!, soloSessionId),
      'stale-after-restart',
      false,
    );
    expect(
      (await nextOfType(staleTokenSocket, 'SeatTakenOver')).payload,
    ).toMatchObject({ seatId });
    expect(
      (await nextOfType(otherSessionSocket, 'SeatTakenOver')).payload,
    ).toMatchObject({ seatId });
    await nextOfType(staleTokenSocket, 'SeatAuthenticated');
    await nextOfType(staleTokenSocket, 'StateSync');
    await closeSocket(staleTokenSocket);
    await waitForReleasedSocket(seatId, soloSessionId);

    // A stale presented token with the wrong cookie is rejected before ticket
    // consumption; retrying that same ticket with the owner cookie recovers.
    const staleWrongCookieTicket = await ticket(tokens[0]!, soloSessionId);
    const staleWrongCookieSocket = connect(
      staleWrongCookieTicket,
      'stale-after-restart',
      false,
      tokens[1]!,
    );
    expect(await closed(staleWrongCookieSocket)).toBe(1008);
    const staleCookieRetry = connect(
      staleWrongCookieTicket,
      'stale-after-restart',
      false,
    );
    await nextOfType(staleCookieRetry, 'SeatAuthenticated');
    await nextOfType(staleCookieRetry, 'StateSync');
    await closeSocket(staleCookieRetry);
    await waitForReleasedSocket(seatId, soloSessionId);
    connections.resetAuthAttemptHistory();

    // A missing row models a restarted server with no usable token state.
    await db.query(
      'DELETE FROM seat_resume_tokens WHERE session_id=$1 AND seat_id=$2',
      [soloSessionId, seatId],
    );
    const wrongCookieTicket = await ticket(tokens[0]!, soloSessionId);
    const wrongCookieSocket = connect(
      wrongCookieTicket,
      null,
      false,
      tokens[1]!,
    );
    expect(await closed(wrongCookieSocket)).toBe(1008);
    // The rejected wrong-cookie attempt must leave this exact ticket usable.
    const wrongCookieRetry = connect(wrongCookieTicket);
    await nextOfType(wrongCookieRetry, 'SeatAuthenticated');
    await nextOfType(wrongCookieRetry, 'StateSync');
    await closeSocket(wrongCookieRetry);
    await waitForReleasedSocket(seatId, soloSessionId);
    await db.query(
      'DELETE FROM seat_resume_tokens WHERE session_id=$1 AND seat_id=$2',
      [soloSessionId, seatId],
    );

    const tokenlessTicket = await ticket(tokens[0]!, soloSessionId);
    const noCookieSocket = connect(tokenlessTicket, null, false, null);
    expect(await closed(noCookieSocket)).toBe(1008);
    // Cookie-less and mismatched-cookie attempts do not consume the ticket.
    connections.resetAuthAttemptHistory();
    const tokenlessSocket = connect(tokenlessTicket, null, false);
    await nextOfType(tokenlessSocket, 'SeatAuthenticated');
    await nextOfType(tokenlessSocket, 'StateSync');
    await closeSocket(tokenlessSocket);
    await waitForReleasedSocket(seatId, soloSessionId);
    // Successful redemption remains single-use.
    expect(
      await consumeTicket(db, tokenlessTicket, soloSessionId),
    ).toBeUndefined();

    // A valid owner cookie does not enable recovery when the flag is off.
    await db.query(
      'DELETE FROM seat_resume_tokens WHERE session_id=$1 AND seat_id=$2',
      [soloSessionId, seatId],
    );
    const flagOffApp = createApp(db, { inputGate: allowInputGate });
    installGateway(
      flagOffApp,
      db,
      rooms,
      new ConnectionRegistry(db),
      15_000,
      false,
    );
    const flagOffBase = await flagOffApp.listen({ host: '127.0.0.1', port: 0 });
    try {
      const flagOffTicket = await ticket(tokens[0]!, soloSessionId);
      const flagOffSocket = connect(
        flagOffTicket,
        null,
        false,
        undefined,
        flagOffBase,
      );
      await nextOfType(flagOffSocket, 'SeatClaimPending');
      expect(seenMessageTypes.get(flagOffSocket)).not.toContain(
        'SeatAuthenticated',
      );
      await closeSocket(flagOffSocket);
    } finally {
      await flagOffApp.close();
    }
    await closeSocket(otherSessionSocket);
    if (priorResumeToken) resumeTokens.set(tokens[0]!, priorResumeToken);
    else resumeTokens.delete(tokens[0]!);
  });
  it('does not hand the initial token to another login session for the same account', async () => {
    const boundSessionId = randomUUID();
    await db.query('INSERT INTO sessions(id,owner_account_id) VALUES($1,$2)', [
      boundSessionId,
      accounts[1],
    ]);
    const room = await rooms.get(boundSessionId);
    const expectedToken = await room.seat(
      accounts[1]!,
      'Bound player',
      false,
      hashToken(tokens[1]!),
    );
    const otherLogin = await createSession(db, accounts[1]!, 'second login');

    const wrongSession = connect(
      await ticket(otherLogin, boundSessionId),
      null,
      false,
    );
    await nextOfType(wrongSession, 'SeatClaimPending');
    expect(seenMessageTypes.get(wrongSession)).not.toContain(
      'SeatAuthenticated',
    );
    await closeSocket(wrongSession);

    const boundSocket = connect(
      await ticket(tokens[1]!, boundSessionId),
      null,
      false,
    );
    const authenticated = await nextOfType(boundSocket, 'SeatAuthenticated');
    expect(authenticated.payload.resumeToken).not.toBe(expectedToken);
    await closeSocket(boundSocket);
  });

  it('refuses a second tokenless socket while the first delivery is in flight', async () => {
    const firstSessionId = randomUUID();
    await db.query('INSERT INTO sessions(id,owner_account_id) VALUES($1,$2)', [
      firstSessionId,
      accounts[0],
    ]);
    const room = await rooms.get(firstSessionId);
    await room.seat(accounts[0], 'Initial owner', false, hashToken(tokens[0]!));
    const first = connect(
      await ticket(tokens[0]!, firstSessionId),
      null,
      false,
    );
    const second = connect(
      await ticket(tokens[0]!, firstSessionId),
      null,
      false,
    );
    const secondClosed = closed(second);
    const authenticated = await nextOfType(first, 'SeatAuthenticated');
    expect(authenticated.payload).toHaveProperty('resumeToken');
    expect(await secondClosed).toBe(1008);
    await closeSocket(first);
  });

  it('does not deliver a rotated token when its database commit fails', async () => {
    const failedSessionId = randomUUID();
    await db.query('INSERT INTO sessions(id,owner_account_id) VALUES($1,$2)', [
      failedSessionId,
      accounts[0],
    ]);
    const room = await rooms.get(failedSessionId);
    const previousToken = await room.seat(accounts[0], 'Commit failure owner');
    if (!previousToken) throw new Error('initial resume token was not created');
    room.completeSeatResumeTokenDelivery(accounts[0]!, hashToken(tokens[0]!));
    const seatId = room.state.seats[0]!.seatId;
    const before = await db.query<{ token_hash: string }>(
      'SELECT token_hash FROM seat_resume_tokens WHERE session_id=$1 AND seat_id=$2',
      [failedSessionId, seatId],
    );
    await db.query(`
      CREATE FUNCTION fail_resume_token_commit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.session_id = '${failedSessionId}'::uuid AND OLD.token_hash IS DISTINCT FROM NEW.token_hash THEN
          RAISE EXCEPTION 'injected resume-token commit failure';
        END IF;
        RETURN NEW;
      END $$
    `);
    await db.query(`
      CREATE TRIGGER fail_resume_token_commit
      BEFORE UPDATE ON seat_resume_tokens FOR EACH ROW
      EXECUTE FUNCTION fail_resume_token_commit()
    `);
    try {
      const socket = connect(
        await ticket(tokens[0]!, failedSessionId),
        previousToken,
        false,
      );
      expect(await closed(socket)).toBe(1011);
      expect(seenMessageTypes.get(socket)).not.toContain('SeatAuthenticated');
      const after = await db.query<{ token_hash: string }>(
        'SELECT token_hash FROM seat_resume_tokens WHERE session_id=$1 AND seat_id=$2',
        [failedSessionId, seatId],
      );
      expect(after.rows[0]?.token_hash).toBe(before.rows[0]?.token_hash);
    } finally {
      await db.query(
        'DROP TRIGGER fail_resume_token_commit ON seat_resume_tokens',
      );
      await db.query('DROP FUNCTION fail_resume_token_commit()');
    }
  });

  it('creates a resume-token row whenever a seat is created', async () => {
    const createdSession = randomUUID();
    await db.query('INSERT INTO sessions(id,owner_account_id) VALUES($1,$2)', [
      createdSession,
      accounts[0],
    ]);
    const room = await rooms.get(createdSession);
    const issuedToken = await room.seat(
      accounts[0],
      'Token row player',
      false,
      hashToken(tokens[0]!),
    );
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
    expect(issuedToken).toMatch(/^[A-Za-z0-9_-]{32}$/);
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
    const presentedTokenWithoutRow = await authorizeSeatSocket(
      db,
      sessionId,
      seatId,
      randomUUID(),
      tokens[0],
    );
    expect(presentedTokenWithoutRow).toEqual({ status: 'invalid-token' });
    // Restore fixture state through the same host-approved recovery path.
    const socketId = randomUUID();
    const recovered = await authorizeSeatSocket(
      db,
      sessionId,
      seatId,
      socketId,
      undefined,
      true,
      accounts[0],
    );
    expect(recovered).toEqual({ status: 'invalid-token' });
    const restored = await db.query(
      'SELECT 1 FROM seat_resume_tokens WHERE session_id=$1 AND seat_id=$2',
      [sessionId, seatId],
    );
    expect(restored.rowCount).toBe(0);
    await releaseSeatSocket(db, sessionId, seatId, socketId);
    // Restore only the isolated shared fixture after proving production auth
    // refuses to recreate a deleted row, so later socket tests start valid.
    const pendingToken = resumeTokens.get(tokens[0]!);
    if (!pendingToken) throw new Error('test fixture token is missing');
    await db.query(
      `INSERT INTO seat_resume_tokens(session_id,seat_id,token_hash,rotated_at)
       VALUES($1,$2,$3,clock_timestamp())`,
      [
        sessionId,
        seatId,
        createHash('sha256').update(pendingToken).digest('hex'),
      ],
    );
  });
  it('rejects an approved claim when persisted seat membership is revoked', async () => {
    const revokedSessionId = randomUUID();
    await db.query('INSERT INTO sessions(id,owner_account_id) VALUES($1,$2)', [
      revokedSessionId,
      accounts[0],
    ]);
    const room = await rooms.get(revokedSessionId);
    await room.seat(accounts[0], 'Host');
    await joinSeated(room, accounts[1], { send() {} }, 'Revoked claimant');
    const seat = room.state.seats.find(
      (candidate) => candidate.accountId === accounts[1],
    )!;
    await room.kickSeat(accounts[0], randomUUID(), seat.seatId);

    // Model a row surviving/reappearing around the membership race. Even an
    // approved claim must re-check persisted membership under its DB claim.
    await db.query(
      `INSERT INTO seat_resume_tokens(session_id,seat_id,token_hash,rotated_at)
       VALUES($1,$2,'unmatchable-test-hash',clock_timestamp())`,
      [revokedSessionId, seat.seatId],
    );
    const socketId = randomUUID();
    const result = await authorizeSeatSocket(
      db,
      revokedSessionId,
      seat.seatId,
      socketId,
      undefined,
      true,
      accounts[1],
    );
    expect(result).toEqual({ status: 'invalid-token' });
    const row = await db.query<{ active_socket_id: string | null }>(
      'SELECT active_socket_id FROM seat_resume_tokens WHERE session_id=$1 AND seat_id=$2',
      [revokedSessionId, seat.seatId],
    );
    expect(row.rows[0]?.active_socket_id).toBeNull();
  });
  it('restores socket control within the two-second target after resume proof', async () => {
    const startedAt = performance.now();
    const socket = connect(await ticket(tokens[0]!));
    await nextOfType(socket, 'SeatAuthenticated');
    expect(performance.now() - startedAt).toBeLessThan(2_000);
    await nextOfType(socket, 'StateSync');
    expect(seenMessageTypes.get(socket)).toEqual(
      expect.arrayContaining(['SeatResumeChallenge', 'SeatAuthenticated']),
    );
    await closeSocket(socket);
    const seatId = (await rooms.get(sessionId)).state.seats.find(
      (seat) => seat.accountId === accounts[0],
    )!.seatId;
    await waitForReleasedSocket(seatId);
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
  it('cannot replay an already-redeemed ticket after its authorized socket closes', async () => {
    const t = await ticket(tokens[0]);
    const first = connect(t);
    await nextOfType(first, 'SeatAuthenticated');
    await nextOfType(first, 'StateSync');
    await closeSocket(first);
    const replay = connect(t);
    expect(await closed(replay)).toBe(1008);
  });

  it('keeps pending late-join identity details host-only', async () => {
    const host = connect(await ticket(tokens[0]));
    const guest = connect(await ticket(tokens[1]));
    await nextOfType(host, 'StateSync');
    await nextOfType(guest, 'StateSync');
    const requestAccountId = randomUUID();
    await db.query(
      `INSERT INTO accounts(id,email,password_hash,display_name,status,is_adult,age_checked_at,terms_version,terms_accepted_at) VALUES($1,$2,'hash','Late joiner','active',true,now(),'v1',now())`,
      [requestAccountId, `${requestAccountId}@example.test`],
    );
    const character = {
      ...quickBuild(loadCatalog(), undefined, 0x35, 1).character,
      id: randomUUID(),
    };
    await new SeatCharacterRepository(db).saveOwnedCharacter(
      requestAccountId,
      character,
    );
    const publicCharacter = {
      name: character.name,
      classId: character.classId,
      level: character.level,
    };
    await (
      await rooms.get(sessionId)
    ).requestLateJoin(
      requestAccountId,
      character.id,
      1,
      randomUUID(),
      'Private requester name',
    );
    let hostSync: Awaited<ReturnType<typeof nextOfType>>;
    do {
      hostSync = await nextOfType(host, 'StateSync');
    } while (
      !hostSync.payload.state.lateJoinRequests?.some(
        (request) =>
          request.displayName === publicCharacter.name &&
          request.classId === publicCharacter.classId &&
          request.level === publicCharacter.level,
      )
    );
    const publicRequest = hostSync.payload.state.lateJoinRequests?.find(
      (request) =>
        request.displayName === publicCharacter.name &&
        request.classId === publicCharacter.classId &&
        request.level === publicCharacter.level,
    );
    expect(publicRequest).toEqual({
      requestId: expect.any(String),
      displayName: character.name,
      classId: character.classId,
      level: character.level,
      expiresAt: expect.any(Number),
    });
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
    const room = await rooms.get(sessionId);
    const claimRequestSpy = vi.spyOn(room, 'requestSeatResumeClaim');
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
    const grantTicket = await ticket(tokens[1]);
    const claimant = connect(grantTicket, 'lost-token');
    const pending = await nextOfType(claimant, 'SeatClaimPending');
    const claimId = pending.payload.claimId!;
    expect(await consumeTicket(db, grantTicket, sessionId)).toBeUndefined();
    await nextOfType(host, 'SeatClaimRequested');
    host.send(
      JSON.stringify({
        actionId: randomUUID(),
        type: 'ApproveSeatClaim',
        payload: { claimId },
        lastSeq: room.seq,
      }),
    );
    await nextOfType(claimant, 'SeatAuthenticated');
    expect(claimRequestSpy).toHaveBeenCalledWith(
      accounts[1],
      claimId,
      hashToken(tokens[1]),
    );
    claimRequestSpy.mockRestore();
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
    const redeemed = await consumeTicket(db, t, sessionId);
    expect(redeemed).toMatchObject({
      accountId: accounts[0],
      sessionId,
      seatId: (await rooms.get(sessionId)).state.seats.find(
        (seat) => seat.accountId === accounts[0],
      )!.seatId,
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
  it("refuses to redeem a ticket whose bound seat is not the account's current seat", async () => {
    const mismatchedSeatTicket = await issueTicket(
      db,
      accounts[0],
      sessionId,
      hashToken(tokens[0]),
      randomUUID(),
    );
    expect(
      await consumeTicket(db, mismatchedSeatTicket, sessionId),
    ).toBeUndefined();
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

  it('never sends another seat account ID in shared snapshot, presence, or claim frames', async () => {
    let host: WebSocket | undefined;
    let guest: WebSocket | undefined;
    let claimant: WebSocket | undefined;
    try {
      host = connect(await ticket(tokens[0]));
      await nextOfType(host, 'StateSync');
      guest = connect(await ticket(tokens[1]));
      await nextOfType(guest, 'StateSync');

      const room = await rooms.get(sessionId);
      const guestSeatId = room.state.seats.find(
        (seat) => seat.accountId === accounts[1],
      )!.seatId;
      const hostSnapshot = (receivedFrames.get(host) ?? []).find(
        (frame) => JSON.parse(frame).type === 'StateSync',
      );
      expect(hostSnapshot).toBeDefined();
      expect(hostSnapshot).not.toContain(accounts[1]);

      await closeSocket(guest);
      await waitForReleasedSocket(guestSeatId);
      await nextOfType(host, 'PresenceChanged', 15_000);

      claimant = connect(await ticket(tokens[1]), 'lost-token');
      await nextOfType(claimant, 'SeatClaimPending');
      const claimRequest = await nextOfType(host, 'SeatClaimRequested');
      expect(claimRequest.payload.seatId).toBe(guestSeatId);
      const frames = receivedFrames.get(host) ?? [];
      expect(
        frames.some((frame) => JSON.parse(frame).type === 'PresenceChanged'),
      ).toBe(true);
      expect(
        frames.some((frame) => JSON.parse(frame).type === 'SeatClaimRequested'),
      ).toBe(true);
      expect(frames.join('\n')).not.toContain(accounts[1]);
    } finally {
      await Promise.all(
        [claimant, guest, host]
          .filter((ws): ws is WebSocket => ws !== undefined)
          .map((ws) => closeSocket(ws)),
      );
    }
  }, 30_000);

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
  it('keeps chat_mutes, room state and events convergent when the mute event append fails', async () => {
    const room = await rooms.get(sessionId);
    const host = connect(await ticket(tokens[0]));
    await nextOfType(host, 'StateSync');
    const guest = connect(await ticket(tokens[1]));
    await nextOfType(guest, 'StateSync');
    const target = room.state.seats.find((s) => s.accountId === accounts[1])!;
    const muted = () =>
      room.state.seats.find((s) => s.seatId === target.seatId)!.chatMuted;
    const until = async (ok: () => Promise<boolean> | boolean) => {
      for (let i = 0; i < 100 && !(await ok()); i++)
        await new Promise((r) => setTimeout(r, 20));
    };
    const muteRow = () =>
      db.query(
        'SELECT source FROM chat_mutes WHERE session_id=$1 AND seat_id=$2',
        [sessionId, target.seatId],
      );
    const lastEvent = async () =>
      (
        await db.query(
          "SELECT payload->>'muted' AS muted FROM events WHERE session_id=$1 AND type='ChatMuteChanged' AND payload->>'seatId'=$2 ORDER BY seq DESC LIMIT 1",
          [sessionId, target.seatId],
        )
      ).rows[0]?.muted;
    const send = async (muted: boolean) => {
      const actionId = randomUUID();
      host.send(
        JSON.stringify({
          type: 'MuteChat',
          payload: { seatId: target.seatId, muted },
          actionId,
          lastSeq: room.seq,
        }),
      );
      return actionId;
    };
    const original = room.setChatMute;
    const failAppend = () => {
      room.setChatMute = () => Promise.reject(new Error('append failed'));
    };
    try {
      // Failed MUTE: no row, no muted state, no event.
      failAppend();
      const failedMute = await send(true);
      await expect(nextOfType(host, 'Error')).resolves.toMatchObject({
        payload: { code: 'ACTION_REJECTED', actionId: failedMute },
      });
      expect((await muteRow()).rowCount).toBe(0);
      expect(muted()).toBeFalsy();
      expect(await lastEvent()).toBeUndefined();

      // Successful MUTE.
      room.setChatMute = original;
      await send(true);
      await until(async () => muted() === true && !!(await lastEvent()));
      expect((await muteRow()).rowCount).toBe(1);
      expect(await lastEvent()).toBe('true');

      // Failed UNMUTE: row restored (fail closed), state and event still muted.
      failAppend();
      const failedUnmute = await send(false);
      await expect(nextOfType(host, 'Error')).resolves.toMatchObject({
        payload: { code: 'ACTION_REJECTED', actionId: failedUnmute },
      });
      expect(await muteRow()).toMatchObject({ rows: [{ source: 'host' }] });
      expect(muted()).toBe(true);
      expect(await lastEvent()).toBe('true');

      // Real unmute converges everything.
      room.setChatMute = original;
      await send(false);
      // Unmute appends the event first and deletes the row last: wait for the row.
      await until(
        async () =>
          !muted() &&
          (await lastEvent()) === 'false' &&
          !(await muteRow()).rowCount,
      );
      expect((await muteRow()).rowCount).toBe(0);
      expect(await lastEvent()).toBe('false');
    } finally {
      room.setChatMute = original;
      await Promise.all([closeSocket(host), closeSocket(guest)]);
    }
  }, 20_000);
  it('serializes host mutes per seat and converges across restart', async () => {
    const room0 = await rooms.get(sessionId);
    const host = connect(await ticket(tokens[0]));
    await nextOfType(host, 'StateSync');
    const guest = connect(await ticket(tokens[1]));
    await nextOfType(guest, 'StateSync');
    const seatId = room0.state.seats.find(
      (s) => s.accountId === accounts[1],
    )!.seatId;
    const hostAccount = accounts[0]!;
    await closeSocket(host);
    await closeSocket(guest);
    const rows = async () =>
      (
        await db.query(
          'SELECT 1 FROM chat_mutes WHERE session_id=$1 AND seat_id=$2',
          [sessionId, seatId],
        )
      ).rowCount === 1;
    const run = async (muted: boolean, failAfterMs?: number) => {
      const room = await rooms.get(sessionId);
      return applyHostChatMute(
        db,
        sessionId,
        seatId,
        muted,
        hostAccount,
        async () => {
          if (failAfterMs !== undefined) {
            await new Promise((r) => setTimeout(r, failAfterMs));
            throw new Error('append failed');
          }
          await room.setChatMute(hostAccount, randomUUID(), seatId, muted);
        },
      );
    };
    const roomMuted = async () =>
      !!(await rooms.get(sessionId)).state.seats.find(
        (s) => s.seatId === seatId,
      )?.chatMuted;
    const restart = async () => {
      await rooms.evictSession(sessionId);
      return roomMuted();
    };
    try {
      // Race: slow failing mute vs real mute must not restore a stale snapshot.
      const [a, b] = await Promise.allSettled([run(true, 60), run(true)]);
      expect([a.status, b.status]).toEqual(['rejected', 'fulfilled']);
      expect(await rows()).toBe(true);
      expect(await roomMuted()).toBe(true);
      expect(await restart()).toBe(true);
      expect(await rows()).toBe(true);

      // Failed unmute then restart: still muted everywhere.
      await expect(run(false, 1)).rejects.toThrow('append failed');
      expect(await rows()).toBe(true);
      expect(await restart()).toBe(true);

      // Double concurrent unmute converges to unmuted.
      await Promise.all([run(false), run(false)]);
      expect(await rows()).toBe(false);
      expect(await roomMuted()).toBe(false);
      expect(await restart()).toBe(false);

      // Failed mute then restart: no row, not muted.
      await expect(run(true, 1)).rejects.toThrow('append failed');
      expect(await rows()).toBe(false);
      expect(await restart()).toBe(false);

      // Concurrent mute + unmute: whatever order, row and room agree.
      await Promise.allSettled([run(true), run(false)]);
      expect(await rows()).toBe(await roomMuted());
      expect(await restart()).toBe(await rows());
    } finally {
      await db.query('DELETE FROM chat_mutes WHERE session_id=$1', [sessionId]);
    }
  }, 30_000);
});

describe('converted solo character privacy over real sockets', () => {
  it('re-keys the owner character and never emits the owner account ID after conversion', async () => {
    const id = randomUUID();
    let owner: WebSocket | undefined;
    let guest: WebSocket | undefined;
    let resumedOwner: WebSocket | undefined;
    const priorGuestToken = resumeTokens.get(tokens[1]!);
    await db.query(
      "INSERT INTO sessions(id,owner_account_id,mode) VALUES($1,$2,'solo')",
      [id, accounts[0]],
    );
    const room = await rooms.get(id);
    const initialToken = await room.seat(
      accounts[0]!,
      'Conversion owner',
      false,
      hashToken(tokens[0]!),
    );
    if (!initialToken) throw new Error('conversion owner has no resume token');
    resumeTokens.set(tokens[0]!, initialToken);
    const repo = new SeatCharacterRepository(db);
    const ownerCharacter = {
      ...quickBuild(loadCatalog(), undefined, 0x51, 1).character,
      id: randomUUID(),
      inventory: [{ itemId: 'item:healing-potion', quantity: 2 }],
    };
    const guestCharacter = {
      ...quickBuild(loadCatalog(), undefined, 0x52, 1).character,
      id: randomUUID(),
    };
    await repo.saveOwnedCharacter(accounts[0]!, ownerCharacter);
    await db.query(
      'UPDATE sessions SET character_id=$2, character=$3::jsonb WHERE id=$1',
      [id, ownerCharacter.id, ownerCharacter],
    );
    const guestRevision = await repo.saveOwnedCharacter(
      accounts[1]!,
      guestCharacter,
    );
    await room.persistGameState({
      characters: { [accounts[0]!]: ownerCharacter },
    });

    try {
      owner = connect(await ticket(tokens[0]!, id));
      await nextOfType(owner, 'StateSync');
      const requestId = await room.requestLateJoin(
        accounts[1]!,
        guestCharacter.id,
        guestRevision,
        randomUUID(),
        'Conversion guest',
      );
      await room.approveLateJoin(accounts[0]!, randomUUID(), requestId);
      await (
        room as unknown as { admitApprovedLateJoins(): Promise<void> }
      ).admitApprovedLateJoins();
      const guestSeat = room.state.seats.find(
        (seat) => seat.accountId === accounts[1],
      )!;
      const guestResumeToken = randomUUID();
      await db.query(
        'UPDATE seat_resume_tokens SET token_hash=$3 WHERE session_id=$1 AND seat_id=$2',
        [id, guestSeat.seatId, hashToken(guestResumeToken)],
      );
      resumeTokens.set(tokens[1]!, guestResumeToken);
      guest = connect(await ticket(tokens[1]!, id));
      const guestSync = await nextOfType(guest, 'StateSync');
      await room.acknowledgeLateJoinSnapshot(
        accounts[1]!,
        guestSeat.seatId,
        guestSync.seq,
      );
      await (
        room as unknown as { admitApprovedLateJoins(): Promise<void> }
      ).admitApprovedLateJoins();
      const ownerFrameCountAfterConversion =
        receivedFrames.get(owner)?.length ?? 0;

      const ownerSeat = room.state.seats.find(
        (seat) => seat.accountId === accounts[0],
      )!;
      expect(room.state.gameState).toMatchObject({
        characters: {
          [ownerSeat.seatId]: expect.objectContaining({
            id: ownerCharacter.id,
          }),
        },
      });
      const ownerFrames = receivedFrames.get(owner) ?? [];
      const guestFrames = receivedFrames.get(guest) ?? [];
      const postConversionOwnerFrames = ownerFrames.slice(
        ownerFrameCountAfterConversion,
      );
      expect(postConversionOwnerFrames.join('\n')).not.toContain(accounts[0]);
      const ownerProjection = (
        room as unknown as {
          clientSyncPayload(viewerAccountId: string): {
            state: { gameState?: { characters?: Record<string, unknown> } };
          };
        }
      ).clientSyncPayload(accounts[0]!);
      expect(ownerProjection.state.gameState?.characters).toHaveProperty(
        ownerSeat.seatId,
      );
      expect(JSON.stringify(ownerProjection)).not.toContain(accounts[0]);
      expect(guestFrames.join('\n')).not.toContain(accounts[0]);

      await Promise.all([closeSocket(owner), closeSocket(guest)]);
      owner = undefined;
      guest = undefined;
      await rooms.evictSession(id);
      const recoveredRoom = await rooms.get(id);
      expect(recoveredRoom.state.gameState).toMatchObject({
        characters: {
          [ownerSeat.seatId]: expect.objectContaining({
            id: ownerCharacter.id,
          }),
        },
      });
      resumedOwner = connect(await ticket(tokens[0]!, id));
      const resumedSync = await nextOfType(resumedOwner, 'StateSync');
      const resumedJson = JSON.stringify(resumedSync);
      expect(resumedJson).not.toContain(accounts[0]);
      expect(resumedSync.payload.state.gameState).toMatchObject({
        characters: {
          [ownerSeat.seatId]: expect.objectContaining({
            id: ownerCharacter.id,
            hp: ownerCharacter.hp,
            inventory: ownerCharacter.inventory,
          }),
        },
      });
    } finally {
      await Promise.all(
        [owner, guest, resumedOwner]
          .filter((ws): ws is WebSocket => Boolean(ws))
          .map((ws) => closeSocket(ws)),
      );
      const roomSeats = room.state.seats;
      for (const seat of roomSeats)
        await waitForReleasedSocket(seat.seatId, id);
      if (priorGuestToken) resumeTokens.set(tokens[1]!, priorGuestToken);
      else resumeTokens.delete(tokens[1]!);
    }
  }, 30_000);
});

describe('party character binding WebSocket authorization', () => {
  async function fixture() {
    const id = randomUUID();
    await db.query(
      "INSERT INTO sessions(id,owner_account_id,mode) VALUES($1,$2,'party')",
      [id, accounts[0]],
    );
    const room = await rooms.get(id);
    const prior0 = resumeTokens.get(tokens[0]!);
    const prior1 = resumeTokens.get(tokens[1]!);
    const initial0 = await room.seat(
      accounts[0]!,
      'Binding owner',
      false,
      hashToken(tokens[0]!),
    );
    const initial1 = await room.seat(
      accounts[1]!,
      'Unbound guest',
      false,
      hashToken(tokens[1]!),
    );
    resumeTokens.set(tokens[0]!, initial0!);
    resumeTokens.set(tokens[1]!, initial1!);
    const catalog = loadCatalog();
    const repo = new SeatCharacterRepository(db);
    const owned = {
      ...quickBuild(catalog, undefined, 0x31, 1).character,
      id: randomUUID(),
    };
    const foreign = {
      ...quickBuild(catalog, undefined, 0x32, 1).character,
      id: randomUUID(),
    };
    const revision = await repo.saveOwnedCharacter(accounts[0]!, owned);
    await repo.saveOwnedCharacter(accounts[1]!, foreign);
    const owner = connect(await ticket(tokens[0]!, id));
    const guest = connect(await ticket(tokens[1]!, id));
    await nextOfType(owner, 'StateSync');
    await nextOfType(guest, 'StateSync');
    return {
      id,
      room,
      owner,
      guest,
      owned,
      foreign,
      revision,
      repo,
      prior0,
      prior1,
    };
  }
  async function bind(
    ws: WebSocket,
    room: { seq: number },
    characterId: string,
    expectedRevision: number,
    actionId = randomUUID(),
  ) {
    ws.send(
      JSON.stringify({
        actionId,
        type: 'BindCharacter',
        payload: { characterId, expectedRevision },
        lastSeq: room.seq,
      }),
    );
    return actionId;
  }
  async function shutdown(f: Awaited<ReturnType<typeof fixture>>) {
    await Promise.all([closeSocket(f.owner), closeSocket(f.guest)]);
    for (const seat of f.room.state.seats)
      await waitForReleasedSocket(seat.seatId, f.id);
    if (f.prior0) resumeTokens.set(tokens[0]!, f.prior0);
    else resumeTokens.delete(tokens[0]!);
    if (f.prior1) resumeTokens.set(tokens[1]!, f.prior1);
    else resumeTokens.delete(tokens[1]!);
  }

  it('replies INVALID_ACTION when a character binding has a malformed UUID', async () => {
    const f = await fixture();
    try {
      const actionId = randomUUID();
      f.owner.send(
        JSON.stringify({
          actionId,
          type: 'BindCharacter',
          payload: { characterId: 'not-a-uuid', expectedRevision: f.revision },
          lastSeq: f.room.seq,
        }),
      );
      await expect(nextOfType(f.owner, 'Error')).resolves.toMatchObject({
        payload: { code: 'INVALID_ACTION', actionId },
      });
    } finally {
      await shutdown(f);
    }
  }, 30_000);

  it('broadcasts identifier-only bind, privately confirms to owner, and makes actionId retries idempotent', async () => {
    const f = await fixture();
    try {
      const ownerSeatId = f.room.state.seats.find(
        (seat) => seat.accountId === accounts[0],
      )!.seatId;
      const actionId = await bind(f.owner, f.room, f.owned.id, f.revision);
      const publicEvent = await nextOfType(f.guest, 'SeatCharacterBound');
      expect(publicEvent.payload).toEqual({ seatId: ownerSeatId });
      const ownerEvent = await nextOfType(f.owner, 'SeatCharacterBound');
      expect(ownerEvent.payload).toEqual({ seatId: ownerSeatId });
      expect(
        await nextOfType(f.owner, 'SeatCharacterBoundPrivate'),
      ).toMatchObject({ payload: { seatId: ownerSeatId } });
      await bind(f.owner, f.room, f.owned.id, f.revision, actionId);
      // Barrier instead of a sleep: the gateway handles one socket's frames in order,
      // so the first Error after the retry must be this rejected barrier action.
      // A retry that wrongly errors arrives first and fails the actionId match.
      const barrier = await bind(f.owner, f.room, randomUUID(), f.revision);
      expect(await nextOfType(f.owner, 'Error')).toMatchObject({
        payload: { actionId: barrier },
      });
      expect(
        (
          await db.query(
            "SELECT count(*)::int AS n FROM events WHERE session_id=$1 AND type='SeatCharacterBound'",
            [f.id],
          )
        ).rows[0]!.n,
      ).toBe(1);
    } finally {
      await shutdown(f);
    }
  }, 15_000); // Includes two DB-backed WS handshakes and their StateSync frames.

  it('rejects revoked, foreign-owned, unknown, stale, and gameplay actions from unbound seats with non-disclosing errors', async () => {
    const f = await fixture();
    try {
      const sendAndError = async (characterId: string, revision: number) => {
        const actionId = await bind(f.owner, f.room, characterId, revision);
        return nextOfType(f.owner, 'Error').then((m) => ({ actionId, m }));
      };
      const foreign = await sendAndError(f.foreign.id, 1);
      const unknown = await sendAndError(randomUUID(), 1);
      expect(foreign.m.payload).toMatchObject({
        code: 'ACTION_REJECTED',
        actionId: foreign.actionId,
        message: 'Character could not be bound.',
      });
      expect(unknown.m.payload).toMatchObject({
        code: 'ACTION_REJECTED',
        actionId: unknown.actionId,
        message: 'Character could not be bound.',
      });
      expect(foreign.m.payload.code).toBe(unknown.m.payload.code);
      expect(foreign.m.payload.message).toBe(unknown.m.payload.message);
      const stale = await sendAndError(f.owned.id, f.revision + 1);
      expect(stale.m.payload).toMatchObject({
        code: 'STALE_REVISION',
        actionId: stale.actionId,
      });

      await bind(f.owner, f.room, f.owned.id, f.revision);
      await nextOfType(f.owner, 'SeatCharacterBound');
      await nextOfType(f.owner, 'SeatCharacterBoundPrivate');
      const duplicate = await sendAndError(f.owned.id, f.revision);
      expect(duplicate.m.payload).toMatchObject({
        code: 'ALREADY_BOUND',
        actionId: duplicate.actionId,
      });

      const gameplayId = randomUUID();
      f.guest.send(
        JSON.stringify({
          actionId: gameplayId,
          type: 'PlayerAction',
          payload: { text: 'I act before binding.' },
          lastSeq: f.room.seq,
        }),
      );
      await expect(nextOfType(f.guest, 'Error')).resolves.toMatchObject({
        payload: { code: 'ACTION_REJECTED', actionId: gameplayId },
      });

      const ownerSeat = f.room.state.seats.find(
        (seat) => seat.accountId === accounts[0],
      )!;
      // Simulate a concurrent authoritative revocation while the authenticated socket remains open.
      const seq = Number(
        (
          await db.query(
            'SELECT COALESCE(MAX(seq),0)+1 AS n FROM events WHERE session_id=$1',
            [f.id],
          )
        ).rows[0]!.n,
      );
      await db.query(
        "INSERT INTO events(session_id,seq,turn_id,type,payload) VALUES($1,$2,$3,'SeatRevoked',$4::jsonb)",
        [
          f.id,
          seq,
          randomUUID(),
          JSON.stringify({ seatId: ownerSeat.seatId, accountId: accounts[0] }),
        ],
      );
      const revokedId = await bind(f.owner, f.room, f.owned.id, f.revision);
      await expect(nextOfType(f.owner, 'Error')).resolves.toMatchObject({
        payload: { code: 'NOT_SEATED', actionId: revokedId },
      });
      const limited = await sendAndError(f.owned.id, f.revision);
      expect(limited.m.payload).toMatchObject({
        code: 'RATE_LIMITED',
        actionId: limited.actionId,
      });
      const binds = await db.query(
        "SELECT count(*)::int AS count FROM events WHERE session_id=$1 AND type='SeatCharacterBound'",
        [f.id],
      );
      expect(binds.rows[0]!.count).toBe(1);
      expect(ownerSeat.seatId).toBeTruthy();
    } finally {
      await shutdown(f);
    }
  });

  it('keeps the owner binding unchanged after a rejected cross-seat bind (card 35780bbc)', async () => {
    const f = await fixture();
    try {
      await bind(f.owner, f.room, f.owned.id, f.revision);
      await nextOfType(f.owner, 'SeatCharacterBound');
      await nextOfType(f.owner, 'SeatCharacterBoundPrivate');
      const liveRows = () =>
        db.query<{
          id: string;
          seat_id: string;
          account_id: string;
          character_id: string;
          character_revision: number;
          binding_status: string;
        }>(
          `SELECT id,seat_id,account_id,character_id,character_revision,binding_status
             FROM session_seat_characters WHERE session_id=$1 ORDER BY id`,
          [f.id],
        );
      const before = (await liveRows()).rows;
      expect(before).toHaveLength(1);
      const ownerFramesBefore = seenMessageTypes.get(f.owner)!.length;

      const actionId = await bind(f.guest, f.room, f.owned.id, f.revision);
      await expect(nextOfType(f.guest, 'Error')).resolves.toMatchObject({
        payload: {
          code: 'ACTION_REJECTED',
          message: 'Character could not be bound.',
          actionId,
        },
      });
      // Deterministic marker instead of a sleep: the room handles commands serially, so the
      // owner's own re-bind reply (ALREADY_BOUND) can only arrive after any broadcast the
      // guest's rejected attempt would have caused.
      const markerId = await bind(f.owner, f.room, f.owned.id, f.revision);
      await expect(nextOfType(f.owner, 'Error')).resolves.toMatchObject({
        payload: { code: 'ALREADY_BOUND', actionId: markerId },
      });

      expect((await liveRows()).rows).toEqual(before);
      // Between the guest's attempt and the marker the owner heard nothing but the marker itself.
      expect(seenMessageTypes.get(f.owner)!.slice(ownerFramesBefore)).toEqual([
        'Error',
      ]);
    } finally {
      await shutdown(f);
    }
  });

  it('returns the neutral ownership error when another seat requests a bound character', async () => {
    const f = await fixture();
    try {
      await bind(f.owner, f.room, f.owned.id, f.revision);
      await nextOfType(f.owner, 'SeatCharacterBoundPrivate');

      // The guest's broadcast is not part of this assertion. Waiting for it here
      // made the test sensitive to websocket scheduling under the full DB suite.
      // The owner's private confirmation establishes that the binding committed.
      const actionId = await bind(f.guest, f.room, f.owned.id, f.revision);
      await expect(nextOfType(f.guest, 'Error')).resolves.toMatchObject({
        payload: {
          code: 'ACTION_REJECTED',
          message: 'Character could not be bound.',
          actionId,
        },
      });
    } finally {
      await shutdown(f);
    }
  });
});
