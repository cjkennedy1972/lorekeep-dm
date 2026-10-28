// @vitest-environment node
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import WebSocket from 'ws';
import { createMock } from '../../mock/server.js';
import { createRoomClient, removalForClose } from './client.js';

const sockets: WebSocket[] = [];
class TrackedWS extends WebSocket {
  constructor(url: string) {
    super(url);
    sockets.push(this);
  }
}
const WSImpl = TrackedWS as unknown as typeof globalThis.WebSocket;

let server: Server;
let base: string;
beforeEach(async () => {
  server = createMock({ scriptedFlipMs: 0 });
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(() => void server.close());

async function cookieFetch(): Promise<typeof fetch> {
  const res = await fetch(`${base}/api/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: 'c@example.com',
      password: 'correct-horse-battery',
      displayName: 'Cy',
      birthdate: '1990-01-01',
    }),
  });
  const cookie = res.headers.get('set-cookie')!.split(';')[0]!;
  // Tickets only issue to a seated account, so seat Cy at a table first.
  await fetch(`${base}/api/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ name: 'Client Table' }),
  });
  return (url, init) =>
    fetch(url, { ...init, headers: { ...init?.headers, cookie } });
}

test('connects with ticket, gets StateSync, resumes after socket drop', async () => {
  const client = createRoomClient({
    baseUrl: base,
    fetchImpl: await cookieFetch(),
    WebSocketImpl: WSImpl,
    baseDelayMs: 10,
  });
  const statuses: string[] = [];
  client.subscribe(() => {
    const s = client.getSnapshot().status;
    if (statuses.at(-1) !== s) statuses.push(s);
  });
  client.start();
  await vi.waitFor(() =>
    expect(client.getSnapshot().room?.seats).toHaveLength(2),
  );
  const first = client.getSnapshot().lastSeq;
  const mine = () =>
    client.getSnapshot().room?.seats.find((s) => s.displayName === 'Cy');
  expect(mine()?.presence).toBe('connected');
  expect(client.getSnapshot().mySeatId).toBe(mine()?.seatId);

  sockets[0]!.terminate(); // abrupt drop
  await vi.waitFor(() => expect(statuses).toContain('reconnecting'));
  await vi.waitFor(() => {
    const s = client.getSnapshot();
    expect(s.status).toBe('connected');
    expect(s.lastSeq).toBeGreaterThan(first);
    expect(mine()?.presence).toBe('connected');
  });
  expect(sockets.length).toBeGreaterThan(1);
  client.stop();
  expect(client.getSnapshot().status).toBe('closed');
});

test('ignores a ticket request from a stopped connection after restart', async () => {
  const realFetch = await cookieFetch();
  let releaseFirstFetch: (() => void) | undefined;
  let fetchCount = 0;
  const fetchImpl: typeof fetch = (input, init) => {
    fetchCount++;
    if (fetchCount === 1) {
      return new Promise((resolve, reject) => {
        releaseFirstFetch = () => {
          void realFetch(input, init).then(resolve, reject);
        };
      });
    }
    return realFetch(input, init);
  };
  const client = createRoomClient({
    baseUrl: base,
    fetchImpl,
    WebSocketImpl: WSImpl,
  });
  const previousSocketCount = sockets.length;

  // Mirrors React StrictMode's setup -> cleanup -> setup while the first
  // ticket request is still in flight.
  client.start();
  client.stop();
  client.start();
  await vi.waitFor(() => expect(client.getSnapshot().status).toBe('connected'));
  releaseFirstFetch?.();
  await new Promise((r) => setTimeout(r, 30));

  expect(sockets).toHaveLength(previousSocketCount + 1);
  client.stop();
});

test('invalid server messages surface an error without crashing', async () => {
  const client = createRoomClient({
    baseUrl: base,
    fetchImpl: await cookieFetch(),
    WebSocketImpl: WSImpl,
  });
  client.start();
  await vi.waitFor(() => expect(client.getSnapshot().room).not.toBeNull());
  const ws = sockets.at(-1)!;
  ws.emit('message', Buffer.from('{"type":"Nope","seq":1}'), false);
  await vi.waitFor(() =>
    expect(client.getSnapshot().error).toMatch(/unrecognised/),
  );
  ws.emit('message', Buffer.from('not json'), false);
  await vi.waitFor(() =>
    expect(client.getSnapshot().error).toMatch(/malformed/),
  );
  expect(client.getSnapshot().room).not.toBeNull();
  client.stop();
});

test('send reports whether the message went out', async () => {
  const client = createRoomClient({
    baseUrl: base,
    fetchImpl: await cookieFetch(),
    WebSocketImpl: WSImpl,
    baseDelayMs: 10,
  });
  expect(client.send('PlayerAction', { text: 'hi' })).toBe(false);
  client.start();
  await vi.waitFor(() => expect(client.getSnapshot().status).toBe('connected'));
  expect(client.send('Resync')).toEqual(expect.any(String));
  client.stop();
});

test('removalForClose matches only the host kick and table-end close pairs', () => {
  expect(removalForClose(1008, 'Seat revoked by the host')).toBe('kicked');
  expect(removalForClose(1000, 'Table ended by host')).toBe('ended');
  expect(
    removalForClose(1008, 'Player is not seated at this table'),
  ).toBeNull();
  expect(removalForClose(1008, 'Room is full')).toBeNull();
  expect(removalForClose(1006, '')).toBeNull();
});

test('a kicked seat shows removed, stops reconnecting and stops sending', async () => {
  const client = createRoomClient({
    baseUrl: base,
    fetchImpl: await cookieFetch(),
    WebSocketImpl: WSImpl,
    baseDelayMs: 10,
  });
  client.start();
  await vi.waitFor(() => expect(client.getSnapshot().status).toBe('connected'));
  const opened = sockets.length;
  sockets.at(-1)!.emit('close', 1008, Buffer.from('Seat revoked by the host'));
  await vi.waitFor(() => expect(client.getSnapshot().removed).toBe('kicked'));
  expect(client.getSnapshot().status).toBe('closed');
  expect(client.send('Resync')).toBe(false);
  await new Promise((r) => setTimeout(r, 60));
  expect(sockets.length).toBe(opened);
  client.stop();
});

test('a not-seated close is neutral: no removal, no reconnect loop, manual rejoin works', async () => {
  const client = createRoomClient({
    baseUrl: base,
    fetchImpl: await cookieFetch(),
    WebSocketImpl: WSImpl,
    baseDelayMs: 10,
  });
  client.start();
  await vi.waitFor(() => expect(client.getSnapshot().status).toBe('connected'));
  const opened = sockets.length;
  // Self-leave while this account's socket was reconnecting: the server answers with not-seated.
  sockets
    .at(-1)!
    .emit('close', 1008, Buffer.from('Player is not seated at this table'));
  await vi.waitFor(() => expect(client.getSnapshot().unseated).toBe(true));
  expect(client.getSnapshot().removed).toBeNull();
  expect(client.getSnapshot().status).toBe('closed');
  expect(client.send('Resync')).toBe(false);
  await new Promise((r) => setTimeout(r, 60));
  expect(sockets.length).toBe(opened);

  client.start();
  await vi.waitFor(() => expect(client.getSnapshot().status).toBe('connected'));
  expect(client.getSnapshot().unseated).toBe(false);
  expect(sockets.length).toBe(opened + 1);
  client.stop();
});

test('clears a stored resume token after the host denies its claim', async () => {
  const values = new Map<string, string>([
    ['lorekeep.seat-resume-token:denied-claim', 'stale-token'],
  ]);
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  const client = createRoomClient({
    baseUrl: base,
    sessionId: 'denied-claim',
    fetchImpl: await cookieFetch(),
    WebSocketImpl: WSImpl,
  });
  client.start();
  await vi.waitFor(() => expect(client.getSnapshot().status).toBe('connected'));
  const ws = sockets.at(-1)!;
  ws.emit(
    'message',
    Buffer.from(
      JSON.stringify({
        seq: client.getSnapshot().lastSeq,
        type: 'SeatClaimPending',
        payload: { claimId: 'claim-1' },
      }),
    ),
    false,
  );
  expect(client.getSnapshot().error).toBe(
    'A host must approve this device to reconnect. If you are the sole host and have no saved seat token, recovery on a fresh device is currently unavailable; reconnect from the browser or device that has the saved token.',
  );
  ws.emit(
    'message',
    Buffer.from(
      JSON.stringify({
        seq: client.getSnapshot().lastSeq,
        type: 'SeatClaimDenied',
        payload: { claimId: 'claim-1' },
      }),
    ),
    false,
  );
  await vi.waitFor(() =>
    expect(values.has('lorekeep.seat-resume-token:denied-claim')).toBe(false),
  );
  client.stop();
  vi.unstubAllGlobals();
});

/** A socket that opens but never authenticates, or never opens at all. */
function silentSockets() {
  const made: { closed: boolean }[] = [];
  class SilentSocket {
    static OPEN = 1;
    readyState = 0;
    closed = false;
    onopen: (() => void) | null = null;
    onmessage: ((e: unknown) => void) | null = null;
    onclose: ((e: unknown) => void) | null = null;
    onerror: (() => void) | null = null;
    constructor() {
      made.push(this);
    }
    send() {}
    close() {
      this.closed = true;
      this.readyState = 3;
    }
  }
  return {
    made,
    WebSocketImpl: SilentSocket as unknown as typeof globalThis.WebSocket,
  };
}

const ticketFetch = (
  ticket: () => Promise<Response> | undefined = () => undefined,
) => {
  let calls = 0;
  const fetchImpl = (() => {
    calls++;
    return (
      ticket() ??
      Promise.resolve(
        new Response(JSON.stringify({ ticket: 'ticket' }), { status: 200 }),
      )
    );
  }) as unknown as typeof fetch;
  return { fetchImpl, calls: () => calls };
};

test('frames from a superseded socket are ignored after a reconnect', async () => {
  const client = createRoomClient({
    baseUrl: base,
    fetchImpl: await cookieFetch(),
    WebSocketImpl: WSImpl,
    baseDelayMs: 10,
  });
  client.start();
  await vi.waitFor(() => expect(client.getSnapshot().status).toBe('connected'));
  const stale = sockets.at(-1)!;
  const opened = sockets.length;
  stale.terminate();
  await vi.waitFor(() => {
    expect(sockets.length).toBeGreaterThan(opened);
    expect(client.getSnapshot().status).toBe('connected');
  });
  expect(sockets.at(-1)).not.toBe(stale);
  stale.emit(
    'message',
    Buffer.from(
      JSON.stringify({
        seq: 999_999,
        type: 'Error',
        payload: { code: 'STALE', message: 'stale frame' },
      }),
    ),
    false,
  );
  await new Promise((r) => setTimeout(r, 30));
  expect(client.getSnapshot().error).not.toBe('stale frame');
  expect(client.getSnapshot().lastSeq).toBeLessThan(999_999);
  client.stop();
});

test('a socket that never authenticates is abandoned after the auth timeout', async () => {
  const { made, WebSocketImpl } = silentSockets();
  const client = createRoomClient({
    baseUrl: base,
    fetchImpl: ticketFetch().fetchImpl,
    WebSocketImpl,
    baseDelayMs: 5,
    authTimeoutMs: 40,
  });
  client.start();
  await vi.waitFor(() => expect(made.length).toBeGreaterThanOrEqual(2), {
    timeout: 2000,
  });
  expect(made[0]!.closed).toBe(true);
  expect(client.getSnapshot().status).not.toBe('connected');
  client.stop();
});

test('a ticket request that never settles is retried after the auth timeout', async () => {
  const { made, WebSocketImpl } = silentSockets();
  let first = true;
  const ticket = ticketFetch(() => {
    if (!first) return undefined;
    first = false;
    return new Promise<Response>(() => {});
  });
  const client = createRoomClient({
    baseUrl: base,
    fetchImpl: ticket.fetchImpl,
    WebSocketImpl,
    baseDelayMs: 5,
    authTimeoutMs: 40,
  });
  client.start();
  await vi.waitFor(() => expect(made.length).toBeGreaterThanOrEqual(1), {
    timeout: 2000,
  });
  expect(ticket.calls()).toBeGreaterThanOrEqual(2);
  expect(client.getSnapshot().status).not.toBe('connected');
  client.stop();
});
