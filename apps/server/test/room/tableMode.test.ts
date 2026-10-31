import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Room, type RoomStore } from '../../src/room/Room.js';

const id = randomUUID();
const lease = {
  sessionId: id,
  nodeId: 'node',
  epoch: 1,
  expiresAt: new Date(Date.now() + 60000),
};
const store = {
  async isAccountActive() {
    return true;
  },
  async writeTurn(_s: string, inputs: unknown[]) {
    return {
      events: inputs.map((input, i) => ({
        ...(input as object),
        seq: i + 2,
        sessionId: id,
        ts: new Date(),
      })),
    };
  },
} as unknown as RoomStore;

function roomWith(seatCount: number, partyMode: boolean) {
  const seats = Array.from({ length: seatCount }, (_, i) => ({
    seatId: randomUUID(),
    accountId: randomUUID(),
    displayName: `Seat ${i}`,
    presence: 'offline' as const,
  }));
  const room = new Room(
    store,
    lease,
    {
      snapshot: {
        sessionId: id,
        seq: 1,
        createdAt: new Date(),
        state: { sessionId: id, phase: 'lobby', seats },
      },
      events: [],
    } as never,
    undefined,
    undefined,
    [],
    partyMode,
  );
  return { room, seats };
}

describe('client room snapshot reports the persisted table mode', () => {
  it('a party session reports party even with only its host seated', () => {
    const { room, seats } = roomWith(1, true);
    expect(room.clientState(seats[0]!.accountId).tableMode).toBe('party');
  });

  it('a solo session reports solo', () => {
    const { room, seats } = roomWith(1, false);
    expect(room.clientState(seats[0]!.accountId).tableMode).toBe('solo');
  });

  it('the mode is on the StateSync a seat receives', async () => {
    const { room, seats } = roomWith(1, true);
    const sent: string[] = [];
    await room.subscribe(seats[0]!.accountId, {
      send: (m) => sent.push(JSON.stringify(m)),
    });
    const sync = sent.find((m) => m.includes('"StateSync"'))!;
    expect(sync).toContain('"tableMode":"party"');
  });
});
