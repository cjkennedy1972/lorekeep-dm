import { randomUUID } from 'node:crypto';
import { afterAll, expect, test } from 'vitest';
import {
  startServer,
  createVerifiedAccount,
  createRoom,
  joinRoom,
  connectRoom,
} from './support.js';

type Message = Record<string, unknown>;

let server: Awaited<ReturnType<typeof startServer>>;
afterAll(async () => server?.stop());

const maxSeq = (messages: Message[]) =>
  Math.max(0, ...messages.map((m) => Number(m.seq) || 0));

test('RewindTurn is rejected for guests and when no turn is resolved', async () => {
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

    const send = (conn: typeof g, actionId: string) =>
      conn.socket.send(
        JSON.stringify({
          actionId,
          type: 'RewindTurn',
          payload: {},
          lastSeq: maxSeq(conn.messages),
        }),
      );

    const guestAction = randomUUID();
    const guestErrorFrame = g.waitFor(
      (m) =>
        m.type === 'Error' &&
        (m.payload as { actionId?: string }).actionId === guestAction,
    );
    send(g, guestAction);
    const guestError = await guestErrorFrame;
    expect(guestError.payload).toMatchObject({ code: 'NOT_HOST' });

    const hostAction = randomUUID();
    const hostErrorFrame = h.waitFor(
      (m) =>
        m.type === 'Error' &&
        (m.payload as { actionId?: string }).actionId === hostAction,
    );
    send(h, hostAction);
    const hostError = await hostErrorFrame;
    expect(hostError.payload).toMatchObject({
      code: 'REWIND_REFUSED',
      message: 'There is no resolved turn to rewind.',
    });
  } finally {
    await Promise.all([h.close(), g.close()]);
  }
});
