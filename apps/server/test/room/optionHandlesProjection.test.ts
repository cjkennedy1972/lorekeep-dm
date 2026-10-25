import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { bootstrapped } from './combatFixtures.js';
import { Room, type RoomStore } from '../../src/room/Room.js';

const id = randomUUID();
const lease = {
  sessionId: id,
  nodeId: 'node',
  epoch: 1,
  expiresAt: new Date(Date.now() + 60000),
};
const combat = () => ({ ...bootstrapped().state, optionHandles: handles });
const handles = {
  opt_abcd: { pos: { x: 3, y: 4 }, expiresTurn: 'r1:ent_a', affected: ['g1'] },
};

describe('DM area option handles are not client state', () => {
  it('never reach any seat through StateSync, clientState, or its checkpoint', async () => {
    const seats = [randomUUID(), randomUUID()].map((accountId) => ({
      seatId: randomUUID(),
      accountId,
      displayName: accountId.slice(0, 4),
      presence: 'offline' as const,
    }));
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
    const room = new Room(store, lease, {
      snapshot: {
        sessionId: id,
        seq: 1,
        createdAt: new Date(),
        state: {
          sessionId: id,
          phase: 'lobby',
          seats,
          gameState: {
            combatRoom: combat(),
            checkpoint: { combatRoom: combat() },
          },
        },
      },
      events: [],
    } as never);
    const sent: string[][] = [[], []];
    for (const [i, seat] of seats.entries())
      await room.subscribe(seat.accountId, {
        send: (m) => sent[i]!.push(JSON.stringify(m)),
      });
    for (const [i, seat] of seats.entries()) {
      const sync = sent[i]!.find((m) => m.includes('"StateSync"'))!;
      expect(sync).toContain('activeEntityId');
      expect(sent[i]!.join()).not.toContain('optionHandles');
      expect(sync).not.toContain('optionHandles');
      expect(JSON.stringify(room.clientState(seat.accountId))).not.toContain(
        'optionHandles',
      );
    }
  });
});
