import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Room, type RoomStore } from '../../src/room/Room.js';
import type { SoloTurnRunner } from '../../src/room/dmTurn.js';

const runner = { async run() {} } as unknown as SoloTurnRunner;

/** A party of `seatCount` seated accounts; only `boundSeats` carry a live binding. */
function party(seatCount: number, boundSeats: number) {
  const sessionId = randomUUID();
  const lease = {
    sessionId,
    nodeId: 'node',
    epoch: 1,
    expiresAt: new Date(Date.now() + 60_000),
  };
  const seats = Array.from({ length: seatCount }, () => {
    const accountId = randomUUID();
    return {
      seatId: randomUUID(),
      accountId,
      displayName: accountId.slice(0, 4),
      presence: 'connected' as const,
    };
  });
  const store = {
    async loadLatest() {
      return { snapshot: null, events: [] };
    },
    async loadActiveSeatCharacterBindings() {
      return [];
    },
    // Subscribing commits a presence transition; echo the events back as the real store does.
    async writeTurn(
      _id: string,
      inputs: { seq: number; type: string; payload: unknown }[],
    ) {
      return {
        events: inputs.map((input) => ({
          ...input,
          sessionId,
          ts: new Date(),
        })),
      };
    },
    async isTableHost() {
      return false;
    },
  } as unknown as RoomStore;
  const bindings = seats.slice(0, boundSeats).map((seat) => ({
    seatId: seat.seatId,
    accountId: seat.accountId,
    characterSnapshot: { name: 'Secret sheet name' },
  }));
  const room = new Room(
    store,
    lease,
    {
      snapshot: {
        sessionId,
        seq: 0,
        createdAt: new Date(),
        state: {
          sessionId,
          phase: 'lobby',
          seats,
          gameState: {},
        },
      },
      events: [],
    },
    runner,
    undefined,
    bindings,
    true,
  );
  return { room, seats };
}

async function syncFor(room: Room, accountId: string, lastSeq?: number) {
  const messages: Record<string, unknown>[] = [];
  await room.subscribe(
    accountId,
    { send: (message: Record<string, unknown>) => messages.push(message) },
    ...(lastSeq === undefined ? [] : [lastSeq]),
  );
  const sync = messages.find((message) => message.type === 'StateSync');
  expect(sync).toBeDefined();
  return sync!;
}

describe('ADR-035 step 5: StateSync boundSeatIds across seat counts', () => {
  it.each([2, 3, 4, 5, 6])(
    'lists every live-bound seat of a %i-seat party on reconnect and RESYNC',
    async (seatCount) => {
      const { room, seats } = party(seatCount, seatCount);
      const expected = seats.map((seat) => seat.seatId).toSorted();

      const reconnect = await syncFor(room, seats[0]!.accountId);
      expect(
        (
          reconnect.payload as { boundSeatIds: string[] }
        ).boundSeatIds.toSorted(),
      ).toEqual(expected);

      const resync = await syncFor(room, seats[seatCount - 1]!.accountId, -1);
      expect(
        (resync.payload as { boundSeatIds: string[] }).boundSeatIds.toSorted(),
      ).toEqual(expected);
      expect(JSON.stringify(resync)).not.toContain('Secret sheet name');
      expect(JSON.stringify(resync)).not.toContain('characterSnapshot');
    },
  );

  it.each([2, 4, 6])(
    'lists only the bound seats of a %i-seat party and omits the field when none are bound',
    async (seatCount) => {
      const partial = party(seatCount, seatCount - 1);
      const sync = await syncFor(partial.room, partial.seats[0]!.accountId);
      expect(
        (sync.payload as { boundSeatIds: string[] }).boundSeatIds.toSorted(),
      ).toEqual(
        partial.seats
          .slice(0, seatCount - 1)
          .map((seat) => seat.seatId)
          .toSorted(),
      );
      expect(
        (sync.payload as { boundSeatIds: string[] }).boundSeatIds,
      ).not.toContain(partial.seats[seatCount - 1]!.seatId);

      const none = party(seatCount, 0);
      const empty = await syncFor(none.room, none.seats[0]!.accountId);
      expect(empty.payload).not.toHaveProperty('boundSeatIds');
    },
  );
});
