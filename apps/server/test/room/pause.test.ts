import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Room, type Connection, type RoomStore } from '../../src/room/Room.js';
import type { SoloTurnRequest, SoloTurnRunner } from '../../src/room/dmTurn.js';
import type { LatestState, StoredEvent } from '../../src/persistence/index.js';
import { joinSeated } from '../helpers/room.js';

const sessionId = randomUUID();
const lease = {
  sessionId,
  nodeId: 'node',
  epoch: 1,
  expiresAt: new Date(Date.now() + 60_000),
};

const recorder = (): Connection => ({ send() {} });

const settle = async () => {
  for (let i = 0; i < 10; i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
};

function setup(requests: SoloTurnRequest[], firstTurnGate?: Promise<void>) {
  const events: StoredEvent[] = [];
  const store: RoomStore = {
    async loadLatest(): Promise<LatestState> {
      return { snapshot: null, events: [] };
    },
    async writeTurn(_id, inputs) {
      const stored = inputs.map((input, index) => ({
        ...input,
        seq: events.length + index + 1,
        sessionId,
        ts: new Date(),
      })) as StoredEvent[];
      events.push(...stored);
      return { events: stored };
    },
    async matureEligibleAccounts(accountIds: string[]) {
      return accountIds;
    },
  } as unknown as RoomStore;
  const runner: SoloTurnRunner = {
    async run(request, onEvent) {
      requests.push(request);
      if (requests.length === 1 && firstTurnGate) await firstTurnGate;
      onEvent({ type: 'NarrationTier', tier: 'standard' });
      onEvent({ type: 'NarrationCompleted', narration: 'ok' });
      return {
        narration: 'ok',
        events: [{ type: 'TurnStarted', turnId: 't1' }],
        state: { lastNarration: 'ok', lastPlayerText: request.text },
        turnSeed: '0x0000000000000001',
        usage: { in: 1, out: 1 },
      };
    },
  };
  const room = new Room(store, lease, { snapshot: null, events: [] }, runner);
  return { room, events };
}

describe('table pause', () => {
  it('blocks the next narration while paused, across tiers', async () => {
    const requests: SoloTurnRequest[] = [];
    const { room } = setup(requests);
    const owner = randomUUID();
    await joinSeated(room, owner, recorder(), 'Owner');

    await room.setPaused(owner, true, true);
    await room.submitAction(owner, randomUUID(), 'Open the door.', 'Owner');
    await settle();

    expect(requests).toHaveLength(0);
    expect(room.clientState().paused).toBe(true);
  });

  it('lets a non-host seated player pause but not resume', async () => {
    const requests: SoloTurnRequest[] = [];
    const { room } = setup(requests);
    const owner = randomUUID();
    const guest = randomUUID();
    await joinSeated(room, owner, recorder(), 'Owner');
    await joinSeated(room, guest, recorder(), 'Guest');

    await room.setPaused(guest, true, false);
    expect(room.clientState().paused).toBe(true);

    await expect(room.setPaused(guest, false, false)).rejects.toThrow(
      'Only the table host can resume',
    );
    expect(room.clientState().paused).toBe(true);

    await room.setPaused(owner, false, true);
    expect(room.clientState().paused).toBe(false);
  });

  it('resumes the held turn on clear without losing it', async () => {
    const requests: SoloTurnRequest[] = [];
    const { room } = setup(requests);
    const owner = randomUUID();
    await joinSeated(room, owner, recorder(), 'Owner');

    await room.setPaused(owner, true, true);
    await room.submitAction(owner, randomUUID(), 'Open the door.', 'Owner');
    await settle();
    expect(requests).toHaveLength(0);

    await room.setPaused(owner, false, true);
    await settle();

    expect(requests).toHaveLength(1);
    expect(requests[0]!.text).toBe('Open the door.');
    expect(room.clientState().paused).toBe(false);
  });

  it('drains a queued turn when resumed while a narration is in flight', async () => {
    const requests: SoloTurnRequest[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { room } = setup(requests, gate);
    const owner = randomUUID();
    await joinSeated(room, owner, recorder(), 'Owner');

    await room.submitAction(owner, randomUUID(), 'Open the door.', 'Owner');
    await settle();
    expect(requests).toHaveLength(1);

    await room.setPaused(owner, true, true);
    await room.submitAction(owner, randomUUID(), 'Search the room.', 'Owner');
    await room.setPaused(owner, false, true);

    release();
    await settle();

    expect(requests.map((request) => request.text)).toEqual([
      'Open the door.',
      'Search the room.',
    ]);
    expect(room.clientState().paused).toBe(false);
  });
});
