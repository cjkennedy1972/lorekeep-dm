import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Room, type RoomStore } from '../../src/room/Room.js';
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

const recorder = () => ({ send() {} });

const waitFor = async (done: () => boolean) => {
  for (let i = 0; i < 200 && !done(); i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
};

const settle = async () => {
  for (let i = 0; i < 10; i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
};

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

function setup(requests: SoloTurnRequest[], inFlight: Promise<void>) {
  const events: StoredEvent[] = [];
  const store = {
    async loadLatest(): Promise<LatestState> {
      return { snapshot: null, events: [] };
    },
    async writeTurn(_id: string, inputs: StoredEvent[]) {
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
      if (requests.length === 1) await inFlight;
      onEvent({ type: 'NarrationTier', tier: 'standard' });
      onEvent({ type: 'NarrationCompleted', narration: 'ok' });
      return {
        narration: 'ok',
        events: [{ type: 'TurnStarted', turnId: `t${requests.length}` }],
        state: { lastNarration: 'ok', lastPlayerText: request.text },
        turnSeed: '0x0000000000000001',
        usage: { in: 1, out: 1 },
      };
    },
  };
  const room = new Room(store, lease, { snapshot: null, events: [] }, runner);
  return { room, events };
}

/**
 * xc-018, xc-019, xc-023: pause pressed while a DM turn is in flight. Expected
 * (stop-after-inflight): the in-flight turn completes, no further DM turn starts,
 * and the only state change is the pause flag plus the queued action held.
 * Room has no anonymous pause path (setPaused needs a seat), so xc-019's
 * anonymous signal is replayed as a seated pause; the room does not inspect
 * narration content, so the combat/initiative context of xc-019/xc-023 is not
 * modeled here.
 */
describe('X-card pause rows replayed at Room level (M3-28)', () => {
  it.each([
    ['xc-018', 'guest'],
    ['xc-019', 'owner'],
    ['xc-023', 'owner'],
  ] as const)(
    '%s: pause mid-generation lets the in-flight turn finish and starts no further DM turn',
    async (_id, pausedBy) => {
      const requests: SoloTurnRequest[] = [];
      const inFlight = gate();
      const { room, events } = setup(requests, inFlight.promise);
      const owner = randomUUID();
      const guest = randomUUID();
      await joinSeated(room, owner, recorder(), 'Owner');
      await joinSeated(room, guest, recorder(), 'Guest');

      await room.submitAction(owner, randomUUID(), 'Roll initiative.', 'Owner');
      await waitFor(() => requests.length === 1);
      expect(requests).toHaveLength(1);

      const pauser = pausedBy === 'guest' ? guest : owner;
      await room.setPaused(pauser, true, pauser === owner);
      await room.submitAction(owner, randomUUID(), 'Attack.', 'Owner');
      await settle();

      const before = events.length;
      inFlight.open();
      await waitFor(() => events.length > before);
      const committed = events.length;
      expect(committed).toBeGreaterThan(before);
      await settle();
      await settle();

      expect(events.length).toBe(committed);
      expect(requests).toHaveLength(1);
      expect(room.clientState().paused).toBe(true);
    },
  );
});
