import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, expect, test } from 'vitest';
import {
  startServer,
  createVerifiedAccount,
  createRoom,
  joinRoom,
  connectRoom,
  proofDb,
} from './support.js';

type Message = Record<string, unknown>;
type Connection = Awaited<ReturnType<typeof connectRoom>>;

let server: Awaited<ReturnType<typeof startServer>>;
afterAll(async () => server?.stop());

const maxSeq = (messages: Message[]) =>
  Math.max(0, ...messages.map((m) => Number(m.seq) || 0));

const send = (conn: Connection, type: string, payload: object) =>
  conn.socket.send(
    JSON.stringify({
      actionId: randomUUID(),
      type,
      payload,
      lastSeq: maxSeq(conn.messages),
    }),
  );

const latestState = (conn: Connection) =>
  [...conn.messages].reverse().find((m) => m.type === 'StateSync')?.payload as
    | {
        state: {
          paused?: boolean;
          seats: { seatId: string; accountId: string }[];
        };
      }
    | undefined;

test('X-card and pause/resume controls behave in one recorded room session', async () => {
  server = await startServer();
  const host = await createVerifiedAccount(server.url);
  const guest = await createVerifiedAccount(server.url);
  const room = await createRoom(server.url, host);
  await joinRoom(server.url, room.code, guest);
  const h = await connectRoom(server.url, room.id, host);
  const g = await connectRoom(server.url, room.id, guest);
  try {
    await Promise.all([
      h.waitFor((m) => m.type === 'StateSync'),
      g.waitFor((m) => m.type === 'StateSync'),
    ]);
    const seats = latestState(h)!.state.seats;
    const flaggerSeatId = seats.find((s) => s.accountId === guest.id)!.seatId;

    // X-card: anonymous broadcast, seat kept only in the abuse log.
    const hBefore = maxSeq(h.messages);
    const gBefore = maxSeq(g.messages);
    send(g, 'XCard', {});
    const [flagForHost, flagForGuest] = await Promise.all([
      h.waitFor((m) => m.type === 'SafetyFlag' && Number(m.seq) > hBefore),
      g.waitFor((m) => m.type === 'SafetyFlag' && Number(m.seq) > gBefore),
    ]);
    expect(flagForHost.payload).toEqual({ kind: 'x-card' });
    expect(flagForGuest.payload).toEqual({ kind: 'x-card' });
    const broadcast = JSON.stringify([
      ...h.messages.filter((m) => m.type === 'SafetyFlag'),
      ...g.messages.filter((m) => m.type === 'SafetyFlag'),
    ]);
    expect(broadcast).not.toContain(flaggerSeatId);
    expect(broadcast).not.toContain(guest.id);
    const logged = await proofDb.query<{ seat_id: string }>(
      'SELECT seat_id FROM x_card_log WHERE session_id=$1',
      [room.id],
    );
    expect(logged.rows.map((r) => r.seat_id)).toEqual([flaggerSeatId]);

    // Pause: any seated player may pause; only the host may resume.
    const pausedBefore = maxSeq(h.messages);
    send(g, 'PauseTable', { paused: true });
    await h.waitFor(
      (m) =>
        m.type === 'StateSync' &&
        Number(m.seq) > pausedBefore &&
        (m.payload as { state: { paused?: boolean } }).state.paused === true,
    );
    const guestResumeFrom = maxSeq(g.messages);
    send(g, 'PauseTable', { paused: false });
    await delay(300);
    expect(
      g.messages.some(
        (m) =>
          m.type === 'StateSync' &&
          Number(m.seq) > guestResumeFrom &&
          (m.payload as { state: { paused?: boolean } }).state.paused !== true,
      ),
    ).toBe(false);
    expect(latestState(g)?.state.paused).toBe(true);

    const hostResumeFrom = maxSeq(h.messages);
    send(h, 'PauseTable', { paused: false });
    await h.waitFor(
      (m) =>
        m.type === 'StateSync' &&
        Number(m.seq) > hostResumeFrom &&
        (m.payload as { state: { paused?: boolean } }).state.paused !== true,
    );
  } finally {
    await Promise.all([h.close(), g.close()]);
  }
});
