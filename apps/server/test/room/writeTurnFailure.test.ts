import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Room, type RoomStore } from '../../src/room/Room.js';

const sessionId = randomUUID();
const lease = {
  sessionId,
  nodeId: 'node',
  epoch: 1,
  expiresAt: new Date(Date.now() + 60_000),
};

function failingRoom() {
  const store = {
    async loadLatest() {
      throw new Error('reload unavailable');
    },
    async writeTurn() {
      throw new Error('disk full');
    },
    async matureEligibleAccounts(accountIds: string[]) {
      return accountIds;
    },
  } as unknown as RoomStore;
  return new Room(store, lease, { snapshot: null, events: [] });
}

describe('room write failures', () => {
  it('surfaces the original write error from a direct writer when reload also fails', async () => {
    const room = failingRoom();
    await expect(room.persistGameState({ premise: 'x' })).rejects.toThrow(
      'disk full',
    );
  });

  it('surfaces the original write error from persist when reload also fails', async () => {
    const room = failingRoom();
    await expect(room.seat(randomUUID(), 'Owner', false)).rejects.toThrow(
      'disk full',
    );
  });
});
