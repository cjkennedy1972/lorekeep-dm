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
