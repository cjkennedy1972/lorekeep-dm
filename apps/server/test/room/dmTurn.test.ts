import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  CLARIFICATION_TIMEOUT_MS,
  Room,
  type RoomStore,
} from '../../src/room/Room.js';
import type { SoloTurnRequest, SoloTurnRunner } from '../../src/room/dmTurn.js';
import type { LatestState, StoredEvent } from '../../src/persistence/index.js';

const sessionId = randomUUID();
const lease = {
  sessionId,
  nodeId: 'node',
  epoch: 1,
  expiresAt: new Date(Date.now() + 60_000),
};
function setup(runner: SoloTurnRunner) {
  const events: StoredEvent[] = [];
  let snapshot: LatestState['snapshot'] = null;
  const store: RoomStore = {
    async loadLatest() {
      return { snapshot, events: [] };
    },
    async writeTurn(_id, inputs, state) {
      const stored = inputs.map((input, index) => ({
        ...input,
        seq: events.length + index + 1,
        sessionId,
        ts: new Date(),
      })) as StoredEvent[];
      events.push(...stored);
      snapshot = {
        sessionId,
        seq: events.length,
        state,
        createdAt: new Date(),
      };
      return { events: stored };
    },
  };
  return {
    room: new Room(store, lease, { snapshot: null, events: [] }, runner),
    events,
    latestSnapshot: () => snapshot,
    store,
  };
}
const result = {
  narration: 'A quiet result.',
  events: [
    { type: 'TurnStarted', turnId: 't1' },
    { type: 'RollEvent', total: 16 },
  ],
  state: {},
  turnSeed: '0x0000000000000001',
  usage: { in: 1, out: 1 },
};

describe('Room solo DM turn lifecycle', () => {
  it('streams a check before narration, ignores duplicate ids and persists the committed result', async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const runner: SoloTurnRunner = {
      async run(_request, emit) {
        emit({ type: 'RollEvent', turnId: 't1', total: 16 });
        emit({
          type: 'NarrationChunk',
          turnId: 't1',
          text: 'A quiet ',
          index: 0,
        });
        emit({
          type: 'NarrationCompleted',
          turnId: 't1',
          text: 'A quiet result.',
          words: 3,
        });
        await gate;
        return result as never;
      },
    };
    const { room, events, latestSnapshot } = setup(runner);
    const accountId = randomUUID();
    const messages: { type: string }[] = [];
    await room.join(accountId, {
      send: (message) => messages.push(message as { type: string }),
    });
    const actionId = randomUUID();
    expect(
      await room.submitAction(accountId, actionId, 'I check the seal.'),
    ).toBe(true);
    expect(
      await room.submitAction(accountId, actionId, 'I check the seal.'),
    ).toBe(false);
    expect(
      messages.findIndex((message) => message.type === 'RollEvent'),
    ).toBeLessThan(
      messages.findIndex((message) => message.type === 'NarrationChunk'),
    );
    finish();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events.map((event) => event.type)).toEqual([
      'SeatJoined',
      'PresenceChanged',
      'RollEvent',
      'NarrationCompleted',
      'ActionAccepted',
      'GameStateCommitted',
    ]);
    expect(latestSnapshot()?.state).toMatchObject({ actionIds: [actionId] });
  });

  it('rejects actions beyond the per-seat in-flight queue cap', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runner: SoloTurnRunner = {
      async run() {
        await gate;
        return result as never;
      },
    };
    const { room } = setup(runner);
    const accountId = randomUUID();
    const messages: { type: string; payload?: { code?: string } }[] = [];
    const otherMessages: { type: string; payload?: { code?: string } }[] = [];
    await room.join(accountId, {
      send: (message) => messages.push(message as (typeof messages)[number]),
    });
    await room.join(randomUUID(), {
      send: (message) =>
        otherMessages.push(message as (typeof otherMessages)[number]),
    });
    expect(await room.submitAction(accountId, randomUUID(), 'one')).toBe(true);
    expect(await room.submitAction(accountId, randomUUID(), 'two')).toBe(true);
    expect(await room.submitAction(accountId, randomUUID(), 'three')).toBe(
      true,
    );
    await expect(
      room.submitAction(accountId, randomUUID(), 'four'),
    ).rejects.toThrow('ACTION_REJECTED');
    expect(
      otherMessages.some(
        (message) => message.payload?.code === 'ACTION_REJECTED',
      ),
    ).toBe(false);
    release();
  });

  it('keeps the committed game state when a turn ends in a clarifying question', async () => {
    const world = { sceneId: 'crypt', gameEngine: { round: 3 } };
    let call = 0;
    const runner: SoloTurnRunner = {
      async run(request) {
        call += 1;
        if (call === 1) return { ...result, state: world } as never;
        return {
          narration: '',
          events: [],
          state: { characters: [] },
          turnSeed: '0x0000000000000001',
          usage: { in: 1, out: 1 },
          clarification: { actionId: request.actionId, question: 'Which?' },
        } as never;
      },
    };
    const { room, latestSnapshot } = setup(runner);
    const owner = randomUUID();
    await room.join(owner, { send() {} });
    await room.submitAction(owner, randomUUID(), 'look');
    await new Promise((resolve) => setTimeout(resolve, 0));
    await room.submitAction(owner, randomUUID(), 'open it');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const committed = (
      latestSnapshot()?.state as { gameState?: Record<string, unknown> }
    ).gameState;
    expect(committed).toMatchObject(world);
  });

  it('holds an action open for one clarifying answer from its owner, then resolves it once', async () => {
    const requests: SoloTurnRequest[] = [];
    const runner: SoloTurnRunner = {
      async run(request) {
        requests.push(request);
        if (requests.length === 1)
          return {
            narration: '',
            events: [],
            state: {},
            turnSeed: '0x0000000000000001',
            usage: { in: 1, out: 1 },
            clarification: {
              actionId: request.actionId,
              question: 'Which door?',
            },
          } as never;
        return result as never;
      },
    };
    const { room, events } = setup(runner);
    const owner = randomUUID();
    const other = randomUUID();
    const ownerMessages: { type: string; payload?: unknown }[] = [];
    await room.join(owner, {
      send: (message) =>
        ownerMessages.push(message as { type: string; payload?: unknown }),
    });
    await room.join(other, { send() {} });
    const actionId = randomUUID();
    expect(await room.submitAction(owner, actionId, 'open the door')).toBe(
      true,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ownerMessages).toContainEqual(
      expect.objectContaining({
        type: 'ClarificationRequested',
        payload: { actionId, question: 'Which door?' },
      }),
    );
    expect(events.some((event) => event.type === 'ActionAccepted')).toBe(false);
    expect(
      await room.answerClarification(other, actionId, 'the left one'),
    ).toBe(false);
    expect(
      await room.answerClarification(owner, actionId, 'the left one'),
    ).toBe(true);
    expect(await room.answerClarification(owner, actionId, 'again')).toBe(
      false,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(requests).toHaveLength(2);
    expect(requests[1].clarificationAsked).toBe(true);
    expect(requests[1].allowClarification).toBe(false);
    expect(requests[1].text).toContain('the left one');
    expect(
      events
        .filter((event) => event.type === 'ActionAccepted')
        .map((event) => (event.payload as { actionId: string }).actionId),
    ).toEqual([actionId]);
    expect(await room.answerClarification(owner, actionId, 'late')).toBe(false);
  });

  it('withdraws a queued action only for its owner and before it resolves', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const runner: SoloTurnRunner = {
      async run() {
        calls++;
        await gate;
        return result as never;
      },
    };
    const { room, events } = setup(runner);
    const owner = randomUUID();
    const other = randomUUID();
    const ownerMessages: { type: string }[] = [];
    await room.join(owner, {
      send: (message) => ownerMessages.push(message as { type: string }),
    });
    await room.join(other, { send() {} });
    const inFlight = randomUUID();
    const queued = randomUUID();
    expect(await room.submitAction(owner, inFlight, 'first')).toBe(true);
    expect(await room.submitAction(owner, queued, 'second')).toBe(true);
    expect(await room.withdrawAction(other, queued)).toBe(false);
    expect(await room.withdrawAction(owner, inFlight)).toBe(false);
    expect(await room.withdrawAction(owner, queued)).toBe(true);
    expect(await room.withdrawAction(owner, queued)).toBe(false);
    expect(ownerMessages.some((m) => m.type === 'ActionWithdrawn')).toBe(true);
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toBe(1);
    expect(
      events
        .filter((event) => event.type === 'ActionAccepted')
        .map((event) => (event.payload as { actionId: string }).actionId),
    ).toEqual([inFlight]);
    expect(await room.submitAction(owner, queued, 'second')).toBe(true);
  });

  it('allows a later retry after an endpoint failure without persisting action state', async () => {
    let calls = 0;
    const runner: SoloTurnRunner = {
      async run() {
        calls++;
        return { ...result, fallback: 'endpoint-error' } as never;
      },
    };
    const { room, events, latestSnapshot } = setup(runner);
    const accountId = randomUUID();
    await room.join(accountId, { send() {} });
    const actionId = randomUUID();
    expect(await room.submitAction(accountId, actionId, 'I look around.')).toBe(
      true,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events.some((event) => event.type === 'ActionAccepted')).toBe(false);
    expect(
      (latestSnapshot()?.state as { actionIds?: string[] } | undefined)
        ?.actionIds,
    ).toEqual([]);
    expect(await room.submitAction(accountId, actionId, 'I look around.')).toBe(
      true,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toBe(2);
  });

  it('tells the player when a turn throws and allows the same action to be retried', async () => {
    let calls = 0;
    const runner: SoloTurnRunner = {
      async run() {
        calls++;
        if (calls === 1) throw new Error('internal detail that must not leak');
        return result as never;
      },
    };
    const { room, events } = setup(runner);
    const accountId = randomUUID();
    const messages: { type: string; payload?: Record<string, unknown> }[] = [];
    await room.join(accountId, {
      send: (message) => messages.push(message as (typeof messages)[number]),
    });
    const actionId = randomUUID();
    expect(
      await room.submitAction(accountId, actionId, 'I try the latch.'),
    ).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const failure = messages.find((message) => message.type === 'Error');
    expect(failure?.payload).toMatchObject({ code: 'TURN_FAILED', actionId });
    expect(JSON.stringify(failure)).not.toContain('internal detail');
    expect(events.some((event) => event.type === 'ActionAccepted')).toBe(false);
    expect(
      await room.submitAction(accountId, actionId, 'I try the latch.'),
    ).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events.some((event) => event.type === 'ActionAccepted')).toBe(true);
    expect(calls).toBe(2);
  });

  it('keeps an open clarification across a restart so its owner can still answer', async () => {
    const requests: SoloTurnRequest[] = [];
    const runner: SoloTurnRunner = {
      async run(request) {
        requests.push(request);
        if (requests.length === 1)
          return {
            narration: '',
            events: [],
            state: {},
            turnSeed: '0x0000000000000001',
            usage: { in: 1, out: 1 },
            clarification: {
              actionId: request.actionId,
              question: 'Which door?',
            },
          } as never;
        return result as never;
      },
    };
    const { room, store, latestSnapshot } = setup(runner);
    const owner = randomUUID();
    const other = randomUUID();
    await room.join(owner, { send() {} });
    await room.join(other, { send() {} });
    const actionId = randomUUID();
    expect(await room.submitAction(owner, actionId, 'open the door')).toBe(
      true,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    const restarted = new Room(
      store,
      lease,
      { snapshot: latestSnapshot(), events: [] },
      runner,
    );
    expect(await restarted.answerClarification(other, actionId, 'left')).toBe(
      false,
    );
    expect(
      await restarted.answerClarification(owner, actionId, 'the left one'),
    ).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(requests).toHaveLength(2);
    expect(requests[1].text).toContain('the left one');
  });

  it('drops a clarified action once its answer window expires and rejects a late answer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const requests: SoloTurnRequest[] = [];
      const runner: SoloTurnRunner = {
        async run(request) {
          requests.push(request);
          return {
            narration: '',
            events: [],
            state: {},
            turnSeed: '0x0000000000000001',
            usage: { in: 1, out: 1 },
            clarification: {
              actionId: request.actionId,
              question: 'Which door?',
            },
          } as never;
        },
      };
      const { room } = setup(runner);
      const owner = randomUUID();
      const messages: { type: string; payload?: unknown }[] = [];
      await room.join(owner, {
        send: (message) =>
          messages.push(message as { type: string; payload?: unknown }),
      });
      const actionId = randomUUID();
      expect(await room.submitAction(owner, actionId, 'open the door')).toBe(
        true,
      );
      await vi.advanceTimersByTimeAsync(CLARIFICATION_TIMEOUT_MS);
      expect(messages).toContainEqual(
        expect.objectContaining({
          type: 'ActionWithdrawn',
          payload: { actionId },
        }),
      );
      expect(await room.answerClarification(owner, actionId, 'late')).toBe(
        false,
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(requests).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('tells every room member when a clarified action resumes after an answer', async () => {
    let calls = 0;
    const runner: SoloTurnRunner = {
      async run(request) {
        calls++;
        if (calls > 1) return result as never;
        return {
          narration: '',
          events: [],
          state: {},
          turnSeed: '0x0000000000000001',
          usage: { in: 1, out: 1 },
          clarification: {
            actionId: request.actionId,
            question: 'Which door?',
          },
        } as never;
      },
    };
    const { room } = setup(runner);
    const owner = randomUUID();
    const bystander = randomUUID();
    const bystanderMessages: { type: string; payload?: unknown }[] = [];
    await room.join(owner, { send() {} });
    await room.join(bystander, {
      send: (message) =>
        bystanderMessages.push(message as { type: string; payload?: unknown }),
    });
    const actionId = randomUUID();
    expect(await room.submitAction(owner, actionId, 'open the door')).toBe(
      true,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    const queuedBefore = bystanderMessages.filter(
      (m) => m.type === 'ActionQueued',
    ).length;
    expect(await room.answerClarification(owner, actionId, 'left')).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      bystanderMessages.filter((m) => m.type === 'ActionQueued').length,
    ).toBeGreaterThan(queuedBefore);
  });

  it('tells every room member when a clarified action is dropped on timeout', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const runner: SoloTurnRunner = {
        async run(request) {
          return {
            narration: '',
            events: [],
            state: {},
            turnSeed: '0x0000000000000001',
            usage: { in: 1, out: 1 },
            clarification: {
              actionId: request.actionId,
              question: 'Which door?',
            },
          } as never;
        },
      };
      const { room } = setup(runner);
      const owner = randomUUID();
      const bystander = randomUUID();
      const bystanderMessages: { type: string; payload?: unknown }[] = [];
      await room.join(owner, { send() {} });
      await room.join(bystander, {
        send: (message) =>
          bystanderMessages.push(
            message as { type: string; payload?: unknown },
          ),
      });
      const actionId = randomUUID();
      expect(await room.submitAction(owner, actionId, 'open the door')).toBe(
        true,
      );
      await vi.advanceTimersByTimeAsync(CLARIFICATION_TIMEOUT_MS);
      expect(bystanderMessages).toContainEqual(
        expect.objectContaining({
          type: 'ActionWithdrawn',
          payload: { actionId },
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Room commit safety', () => {
  it('does not nest the previous checkpoint inside a new one', async () => {
    const { room, latestSnapshot } = setup({
      async run() {
        throw new Error('unused');
      },
    });
    await room.persistRecap({ recap: 'start', memoryHash: 'h0' });
    await room.saveCheckpoint();
    await room.saveCheckpoint();
    const checkpoint = (
      latestSnapshot()?.state as { gameState: { checkpoint: object } }
    ).gameState.checkpoint as Record<string, unknown>;
    expect(checkpoint.recap).toEqual({ recap: 'start', memoryHash: 'h0' });
    expect(checkpoint.checkpoint).toBeUndefined();
  });

  function gatedRunner() {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const runner: SoloTurnRunner = {
      async run() {
        await gate;
        return result as never;
      },
    };
    return { runner, finish };
  }

  it('keeps a state write made while the DM is narrating', async () => {
    const { runner, finish } = gatedRunner();
    const { room, latestSnapshot } = setup(runner);
    const account = randomUUID();
    await room.join(account, { send() {} });
    expect(await room.submitAction(account, randomUUID(), 'I wait.')).toBe(
      true,
    );
    await room.persistRecap({ recap: 'Previously...', memoryHash: 'h1' });
    finish();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(latestSnapshot()?.state).toMatchObject({
      gameState: { recap: { recap: 'Previously...', memoryHash: 'h1' } },
    });
  });

  it('rejects rest, death-save and TPK writes while the DM is narrating', async () => {
    const { runner, finish } = gatedRunner();
    const { room, latestSnapshot } = setup(runner);
    const account = randomUUID();
    await room.join(account, { send() {} });
    await room.submitAction(account, randomUUID(), 'I wait.');
    await expect(room.takeRest(account, 'short')).rejects.toThrow(
      'still narrating',
    );
    await expect(room.rollDeathSave(account)).rejects.toThrow(
      'still narrating',
    );
    await expect(
      room.chooseTpkResolution(account, 'fail-forward', 'The bridge falls.'),
    ).rejects.toThrow('still narrating');
    await expect(room.persistGameState({ premise: 'x' })).rejects.toThrow(
      'still narrating',
    );
    finish();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(latestSnapshot()).not.toBeNull();
  });

  it('commits an in-flight turn when the room drains mid-narration', async () => {
    const { runner, finish } = gatedRunner();
    const { room, events } = setup(runner);
    const messages: { type: string }[] = [];
    const account = randomUUID();
    await room.join(account, {
      send: (message) => messages.push(message as { type: string }),
    });
    expect(await room.submitAction(account, randomUUID(), 'I wait.')).toBe(
      true,
    );
    const draining = room.drain();
    finish();
    await draining;
    expect(messages.map((message) => message.type)).not.toContain('Error');
    expect(events.map((event) => event.type)).toContain('ActionAccepted');
  });
});
