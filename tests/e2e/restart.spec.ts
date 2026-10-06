import { afterAll, expect, test } from 'vitest';
import {
  proofDb,
  startServer,
  createVerifiedAccount,
  createRoom,
  connectRoom,
} from './support.js';

let server: Awaited<ReturnType<typeof startServer>>;
afterAll(async () => server?.stop());

test('SIGTERM and restart preserves room state and seq; client reconnects', async () => {
  server = await startServer();
  const account = await createVerifiedAccount(server.url);
  const room = await createRoom(server.url, account);
  const first = await connectRoom(server.url, room.id, account);
  await first.waitFor((m) => m.type === 'StateSync');
  const startedAt = Date.now();
  await server.stop('SIGTERM');
  const durable = await proofDb.query<{ seq: string; state: unknown }>(
    'SELECT seq,state FROM snapshots WHERE session_id=$1 ORDER BY seq DESC LIMIT 1',
    [room.id],
  );
  const expected = durable.rows[0];
  if (!expected) throw new Error('Room snapshot was not persisted');
  const oldUrl = server.url;
  server = await startServer();
  expect(server.url).not.toBe(oldUrl);
  const recovered = await connectRoom(
    server.url,
    room.id,
    account,
    Number(expected.seq),
  );
  try {
    const sync = await recovered.waitFor((m) => m.type === 'StateSync', 3_000);
    expect(sync.seq).toBe(Number(expected.seq));
    expect((sync.payload as { state: unknown }).state).toEqual(
      Object.fromEntries(
        Object.entries(expected.state as Record<string, unknown>).filter(
          ([key]) => key !== 'actionIds',
        ),
      ),
    );
    expect(Date.now() - startedAt).toBeLessThanOrEqual(3_000);
  } finally {
    await Promise.all([first.close(), recovered.close()]);
  }
}, 15_000);
