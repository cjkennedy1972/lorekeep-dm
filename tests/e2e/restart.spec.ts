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
    // A normal restart return is not a displacement, so it adds no takeover event.
    expect(sync.seq).toBe(Number(expected.seq));
    const persistedState = expected.state as Record<string, unknown>;
    const persistedSeats = (
      persistedState.seats as Record<string, unknown>[]
    ).map((seat) => {
      const visible = { ...seat };
      delete visible.accountId;
      delete visible.matureOptOut;
      // Account IDs are internal identity data and are intentionally omitted from client state.
      return { ...visible, isSelf: true };
    });
    const persistedSeatIds = new Map(
      (persistedState.seats as Record<string, unknown>[]).map((seat) => [
        String(seat.accountId),
        String(seat.seatId),
      ]),
    );
    const expectedState = Object.fromEntries(
      Object.entries(persistedState)
        .filter(([key]) => key !== 'actionIds')
        .map(([key, value]) => [
          key,
          key === 'seats'
            ? persistedSeats
            : key === 'spotlightActivity' && value && typeof value === 'object'
              ? Object.fromEntries(
                  Object.entries(value as Record<string, unknown>).flatMap(
                    ([accountId, turn]) => {
                      const seatId = persistedSeatIds.get(accountId);
                      return seatId ? [[seatId, turn]] : [];
                    },
                  ),
                )
              : value,
        ]),
    );
    const syncState = (sync.payload as { state: { seats?: unknown[] } }).state;
    // Authenticated recovery marks the seat returning until the reconnect hold elapses.
    const recoveredExpectedState = {
      ...expectedState,
      revokedSeats: [],
      seats: (expectedState.seats as Record<string, unknown>[]).map((seat) => ({
        ...seat,
        presence: 'returning',
      })),
    };
    expect(syncState).toEqual(recoveredExpectedState);
    for (const seat of syncState.seats ?? [])
      expect(seat).not.toHaveProperty('matureOptOut');
    expect(Date.now() - startedAt).toBeLessThanOrEqual(3_000);
  } finally {
    await Promise.all([first.close(), recovered.close()]);
  }
}, 15_000);
