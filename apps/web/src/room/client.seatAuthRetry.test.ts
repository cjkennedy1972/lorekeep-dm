// @vitest-environment node
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  SEAT_AUTH_FAILED_REASON,
  SEAT_AUTH_RETRY_LIMIT,
  SEAT_AUTH_WINDOW_MS,
  SEAT_LEASE_GRACE_MS,
  createRoomClient,
} from './client.js';

// Fake socket: the test decides when it opens, delivers frames, and closes, so
// the retry schedule is driven entirely by fake timers.
const sockets: FakeSocket[] = [];
class FakeSocket {
  static OPEN = 1;
  static CLOSED = 3;
  readyState = 0;
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  send = vi.fn();
  close = vi.fn(() => {
    this.readyState = FakeSocket.CLOSED;
  });
  constructor(public url: string) {
    sockets.push(this);
  }
  open() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.({});
  }
  receive(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  drop(code: number, reason: string) {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.({ code, reason });
  }
}

const fetchImpl = (async () => ({
  ok: true,
  json: async () => ({ ticket: 'ticket' }),
})) as unknown as typeof fetch;

const BASE_DELAY_MS = 10;
const MAX_DELAY_MS = 1_000;

function makeClient() {
  return createRoomClient({
    baseUrl: 'http://127.0.0.1:1',
    fetchImpl,
    WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
    baseDelayMs: BASE_DELAY_MS,
    maxDelayMs: MAX_DELAY_MS,
    authTimeoutMs: 60_000,
  });
}

/** Lets the ticket fetch resolve and the latest socket be created. */
async function settle() {
  await vi.advanceTimersByTimeAsync(0);
}

/** The server rejects the seat resume: close with the auth-failure pair, then let the retry timer run. */
async function failAuthAndRetry() {
  sockets.at(-1)!.drop(1008, SEAT_AUTH_FAILED_REASON);
  await vi.advanceTimersByTimeAsync(MAX_DELAY_MS);
}

function authenticate(client: ReturnType<typeof makeClient>) {
  const socket = sockets.at(-1)!;
  socket.open();
  socket.receive({
    seq: 0,
    type: 'SeatAuthenticated',
    payload: { seatId: '11111111-1111-4111-8111-111111111111' },
  });
  expect(client.getSnapshot().status).toBe('connected');
}

beforeEach(() => {
  sockets.length = 0;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

test('a seat-auth 1008 retries a bounded number of times, then stops and reports it gave up', async () => {
  const client = makeClient();
  client.start();
  await settle();
  expect(sockets).toHaveLength(1);

  for (let i = 0; i < SEAT_AUTH_RETRY_LIMIT; i++) await failAuthAndRetry();
  expect(sockets).toHaveLength(SEAT_AUTH_RETRY_LIMIT + 1);
  expect(client.getSnapshot().reconnectGaveUp).toBe(false);

  // The final failure is not retried: no socket is opened after it.
  sockets.at(-1)!.drop(1008, SEAT_AUTH_FAILED_REASON);
  await vi.advanceTimersByTimeAsync(MAX_DELAY_MS * 5);
  expect(sockets).toHaveLength(SEAT_AUTH_RETRY_LIMIT + 1);

  const snap = client.getSnapshot();
  expect(snap.reconnectGaveUp).toBe(true);
  expect(snap.status).toBe('closed');
  expect(snap.removed).toBeNull();
  expect(snap.unseated).toBe(false);
  client.stop();
});

test('seat-auth retries back off exponentially from the base delay', async () => {
  const client = makeClient();
  client.start();
  await settle();

  sockets.at(-1)!.drop(1008, SEAT_AUTH_FAILED_REASON);
  // First retry: base delay.
  await vi.advanceTimersByTimeAsync(BASE_DELAY_MS - 1);
  expect(sockets).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(sockets).toHaveLength(2);

  sockets.at(-1)!.drop(1008, SEAT_AUTH_FAILED_REASON);
  // Second retry: twice the base delay, so the base delay alone is not enough.
  await vi.advanceTimersByTimeAsync(BASE_DELAY_MS);
  expect(sockets).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(BASE_DELAY_MS);
  expect(sockets).toHaveLength(3);
  client.stop();
});

test('a successful seat authentication resets the seat-auth retry counter', async () => {
  const client = makeClient();
  client.start();
  await settle();

  for (let i = 0; i < SEAT_AUTH_RETRY_LIMIT - 1; i++) await failAuthAndRetry();
  authenticate(client);
  // The authenticated socket drops; wait out its lease grace so refusals count again.
  sockets.at(-1)!.drop(1006, '');
  await vi.advanceTimersByTimeAsync(SEAT_LEASE_GRACE_MS);

  // After a good connect, a full new budget of retries is available again.
  for (let i = 0; i < SEAT_AUTH_RETRY_LIMIT; i++) await failAuthAndRetry();
  expect(client.getSnapshot().reconnectGaveUp).toBe(false);
  expect(client.getSnapshot().status).toBe('reconnecting');

  sockets.at(-1)!.drop(1008, SEAT_AUTH_FAILED_REASON);
  expect(client.getSnapshot().reconnectGaveUp).toBe(true);
  client.stop();
});

test('refusals inside the lease grace after our own socket dropped do not count toward the cap', async () => {
  const client = makeClient();
  client.start();
  await settle();
  authenticate(client);
  sockets.at(-1)!.drop(1006, '');

  // The server still holds the seat lease for up to 15 s, so each refusal here is expected and retried.
  const graceRefusals = Math.floor(SEAT_LEASE_GRACE_MS / MAX_DELAY_MS) - 2;
  for (let i = 0; i < graceRefusals; i++) await failAuthAndRetry();
  expect(client.getSnapshot().reconnectGaveUp).toBe(false);
  expect(client.getSnapshot().status).toBe('reconnecting');

  // Past the grace, the same refusals are a real failure and the cap applies.
  await vi.advanceTimersByTimeAsync(SEAT_LEASE_GRACE_MS);
  for (let i = 0; i < SEAT_AUTH_RETRY_LIMIT; i++) await failAuthAndRetry();
  expect(client.getSnapshot().reconnectGaveUp).toBe(false);
  sockets.at(-1)!.drop(1008, SEAT_AUTH_FAILED_REASON);
  expect(client.getSnapshot().reconnectGaveUp).toBe(true);
  client.stop();
});

test('manual retry inside the seat-auth window is one attempt, and a refusal gives up again at once', async () => {
  const client = makeClient();
  client.start();
  await settle();
  for (let i = 0; i < SEAT_AUTH_RETRY_LIMIT; i++) await failAuthAndRetry();
  sockets.at(-1)!.drop(1008, SEAT_AUTH_FAILED_REASON);
  expect(client.getSnapshot().reconnectGaveUp).toBe(true);
  const stopped = sockets.length;

  client.retry();
  await settle();
  expect(client.getSnapshot().reconnectGaveUp).toBe(false);
  expect(client.getSnapshot().status).toBe('connecting');
  expect(sockets).toHaveLength(stopped + 1);

  // ADR-041: the manual Retry does not reset the window, so its refusal gives up without more automatic retries.
  sockets.at(-1)!.drop(1008, SEAT_AUTH_FAILED_REASON);
  await vi.advanceTimersByTimeAsync(MAX_DELAY_MS * 5);
  expect(sockets).toHaveLength(stopped + 1);
  expect(client.getSnapshot().reconnectGaveUp).toBe(true);
  client.stop();
});

test('manual retry after the seat-auth window has elapsed gets a fresh budget', async () => {
  const client = makeClient();
  client.start();
  await settle();
  for (let i = 0; i < SEAT_AUTH_RETRY_LIMIT; i++) await failAuthAndRetry();
  sockets.at(-1)!.drop(1008, SEAT_AUTH_FAILED_REASON);
  expect(client.getSnapshot().reconnectGaveUp).toBe(true);

  await vi.advanceTimersByTimeAsync(SEAT_AUTH_WINDOW_MS);
  client.retry();
  await settle();
  expect(client.getSnapshot().reconnectGaveUp).toBe(false);
  expect(client.getSnapshot().status).toBe('connecting');

  for (let i = 0; i < SEAT_AUTH_RETRY_LIMIT; i++) await failAuthAndRetry();
  expect(client.getSnapshot().reconnectGaveUp).toBe(false);
  expect(client.getSnapshot().status).toBe('reconnecting');
  client.stop();
});

test('manual retry on a live socket after giving up also reconnects', async () => {
  const client = makeClient();
  client.start();
  await settle();
  for (let i = 0; i < SEAT_AUTH_RETRY_LIMIT; i++) await failAuthAndRetry();
  sockets.at(-1)!.drop(1008, SEAT_AUTH_FAILED_REASON);
  const stopped = sockets.length;

  client.start();
  await settle();
  expect(client.getSnapshot().reconnectGaveUp).toBe(false);
  expect(sockets).toHaveLength(stopped + 1);
  client.stop();
});

test('other transient closes still retry without a cap', async () => {
  const client = makeClient();
  client.start();
  await settle();
  for (let i = 0; i < SEAT_AUTH_RETRY_LIMIT + 3; i++) {
    sockets.at(-1)!.drop(1006, '');
    await vi.advanceTimersByTimeAsync(MAX_DELAY_MS);
  }
  expect(client.getSnapshot().reconnectGaveUp).toBe(false);
  expect(client.getSnapshot().status).toBe('reconnecting');
  client.stop();
});
