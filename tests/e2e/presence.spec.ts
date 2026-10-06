import { afterAll, expect, test } from 'vitest';
import {
  startServer,
  createVerifiedAccount,
  createRoom,
  joinRoom,
  connectRoom,
} from './support.js';

let server: Awaited<ReturnType<typeof startServer>>;
afterAll(async () => server?.stop());

test('two verified accounts join one room and observe synced presence', async () => {
  server = await startServer();
  const first = await createVerifiedAccount(server.url);
  const second = await createVerifiedAccount(server.url);
  const room = await createRoom(server.url, first);
  await joinRoom(server.url, room.code, second);
  const a = await connectRoom(server.url, room.id, first);
  const b = await connectRoom(server.url, room.id, second);
  try {
    const [forA, forB] = await Promise.all([
      a.waitFor(
        (m) =>
          m.type === 'PresenceChanged' &&
          (m.payload as { presence?: string }).presence === 'online',
      ),
      b.waitFor(
        (m) =>
          m.type === 'PresenceChanged' &&
          (m.payload as { presence?: string }).presence === 'online',
      ),
    ]);
    expect(forA.seq).toBeGreaterThan(0);
    expect(forB.seq).toBeGreaterThan(0);
    const stateA = await a.waitFor((m) => m.type === 'StateSync');
    const stateB = await b.waitFor((m) => m.type === 'StateSync');
    expect(
      (stateA.payload as { state: { seats: unknown[] } }).state.seats,
    ).toHaveLength(2);
    expect(
      (stateB.payload as { state: { seats: unknown[] } }).state.seats,
    ).toHaveLength(2);
  } finally {
    await Promise.all([a.close(), b.close()]);
  }
});
