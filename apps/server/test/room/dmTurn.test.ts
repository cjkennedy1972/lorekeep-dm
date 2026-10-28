import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  CLARIFICATION_TIMEOUT_MS,
  Room,
  type RoomStore,
} from '../../src/room/Room.js';
import {
  LiveDmRestrictedError,
  type SoloTurnRequest,
  type SoloTurnRunner,
} from '../../src/room/dmTurn.js';
import type { LatestState, StoredEvent } from '../../src/persistence/index.js';
import {
  account as combatAccount,
  bootstrapped,
  hero,
} from './combatFixtures.js';
import { joinSeated } from '../helpers/room.js';

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
    async isAccountActive() {
      return true;
    },
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
  it('does not queue away autopilot when a DM turn ends before the away PC turn starts', async () => {
    const { state: combat, game } = bootstrapped();
    const runner: SoloTurnRunner = {
      async run() {
        return result as never;
      },
    };
    const { room, events } = setup(runner);
    const awayAccount = randomUUID();
    const actorAccount = randomUUID();
    await joinSeated(room, awayAccount, { send() {} });
    await joinSeated(room, actorAccount, { send() {} });
    room.state = {
      ...room.state,
      seats: room.state.seats.map((seat) =>
        seat.accountId === awayAccount ? { ...seat, presence: 'away' } : seat,
      ),
      gameState: {
        ...(game as object),
        combatRoom: { ...combat, activeEntityId: 'ent_aria' },
        combatActors: { [awayAccount]: 'ent_aria' },
      } as never,
    };

    await room.submitAction(actorAccount, randomUUID(), 'I check the room.');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events.some((event) => event.type === 'AutopilotActed')).toBe(false);
    await room.drain();
  });
  it('broadcasts only turnId for a rejected tool call', async () => {
    const runner: SoloTurnRunner = {
      async run(_request, emit) {
        emit({
          type: 'ToolCallRejected',
          turnId: 'turn-rejected',
          toolName: 'private_tool_name',
          error: 'INVALID_ARGUMENTS',
          attempt: 1,
          argHash: 'private-argument-hash',
        });
        return result as never;
      },
    };
    const { room } = setup(runner);
    const accountId = randomUUID();
    const messages: { type: string; payload?: unknown }[] = [];
    await joinSeated(room, accountId, {
      send: (message) =>
        messages.push(message as { type: string; payload?: unknown }),
    });

    await room.submitAction(accountId, randomUUID(), 'use a tool');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(messages.find((message) => message.type === 'ToolRejected')).toEqual(
      expect.objectContaining({
        type: 'ToolRejected',
        payload: { turnId: 'turn-rejected' },
      }),
    );
  });
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
    const idleAccountId = randomUUID();
    const messages: { type: string }[] = [];
    const idleMessages: { type: string }[] = [];
    await joinSeated(room, accountId, {
      send: (message) => messages.push(message as { type: string }),
    });
    await joinSeated(room, idleAccountId, {
      send: (message) => idleMessages.push(message as { type: string }),
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
      'SeatJoined',
      'PresenceChanged',
      'RollEvent',
      'NarrationCompleted',
      'ActionAccepted',
      'GameStateCommitted',
      'SpotlightPrompted',
    ]);
    expect(messages.some((message) => message.type === 'SpotlightPrompt')).toBe(
      true,
    );
    expect(
      idleMessages.some((message) => message.type === 'SpotlightPrompt'),
    ).toBe(false);
    expect(latestSnapshot()?.state).toMatchObject({
      actionIds: [actionId],
      spotlightTurn: 1,
    });
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
    await joinSeated(room, accountId, {
      send: (message) => messages.push(message as (typeof messages)[number]),
    });
    await joinSeated(room, randomUUID(), {
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
    await joinSeated(room, owner, { send() {} });
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
    const otherMessages: { type: string; payload?: unknown }[] = [];
    await joinSeated(room, owner, {
      send: (message) =>
        ownerMessages.push(message as { type: string; payload?: unknown }),
    });
    await joinSeated(room, other, {
      send: (message) =>
        otherMessages.push(message as { type: string; payload?: unknown }),
    });
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
    expect(
      otherMessages.some(
        (message) => message.type === 'ClarificationRequested',
      ),
    ).toBe(false);
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
    await joinSeated(room, owner, {
      send: (message) => ownerMessages.push(message as { type: string }),
    });
    await joinSeated(room, other, { send() {} });
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

  it('sends endpoint failures only to the submitter and accepts a later retry', async () => {
    let calls = 0;
    const runner: SoloTurnRunner = {
      async run() {
        calls++;
        return calls === 1
          ? ({ ...result, fallback: 'endpoint-error' } as never)
          : (result as never);
      },
    };
    const { room, events, latestSnapshot } = setup(runner);
    const accountId = randomUUID();
    const otherAccountId = randomUUID();
    const messages: { type: string; payload?: Record<string, unknown> }[] = [];
    const otherMessages: { type: string; payload?: Record<string, unknown> }[] =
      [];
    await joinSeated(room, accountId, {
      send: (message) => messages.push(message as (typeof messages)[number]),
    });
    await joinSeated(room, otherAccountId, {
      send: (message) =>
        otherMessages.push(message as (typeof otherMessages)[number]),
    });
    const actionId = randomUUID();
    expect(await room.submitAction(accountId, actionId, 'I look around.')).toBe(
      true,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      messages.find((message) => message.type === 'Error')?.payload,
    ).toMatchObject({
      code: 'TURN_FAILED',
      actionId,
      message: expect.stringMatching(/try again/i),
    });
    expect(otherMessages.some((message) => message.type === 'Error')).toBe(
      false,
    );
    expect(events.some((event) => event.type === 'ActionAccepted')).toBe(false);
    expect(
      (latestSnapshot()?.state as { actionIds?: string[] } | undefined)
        ?.actionIds,
    ).toEqual([]);
    expect(await room.submitAction(accountId, actionId, 'I look around.')).toBe(
      true,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events.some((event) => event.type === 'ActionAccepted')).toBe(true);
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
    await joinSeated(room, accountId, {
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

  it('tells the player a live turn is restricted without exposing the cause', async () => {
    const runner: SoloTurnRunner = {
      async run() {
        throw new LiveDmRestrictedError();
      },
    };
    const { room } = setup(runner);
    const accountId = randomUUID();
    const messages: { type: string; payload?: Record<string, unknown> }[] = [];
    const otherMessages: { type: string; payload?: Record<string, unknown> }[] =
      [];
    await joinSeated(room, accountId, {
      send: (message) => messages.push(message as (typeof messages)[number]),
    });
    await joinSeated(room, randomUUID(), {
      send: (message) =>
        otherMessages.push(message as (typeof otherMessages)[number]),
    });
    const actionId = randomUUID();
    expect(await room.submitAction(accountId, actionId, 'I look.')).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const failure = messages.find((message) => message.type === 'Error');
    expect(failure?.payload).toMatchObject({
      code: 'LIVE_DM_RESTRICTED',
      actionId,
    });
    expect(JSON.stringify(failure?.payload)).not.toMatch(/allowlist|OPERATOR/);
    expect(otherMessages.some((message) => message.type === 'Error')).toBe(
      false,
    );
  });

  it('notifies round submitters of endpoint failure and opens a usable next round', async () => {
    let calls = 0;
    const runner: SoloTurnRunner = {
      async run() {
        calls++;
        return calls === 1
          ? ({ ...result, fallback: 'endpoint-error' } as never)
          : (result as never);
      },
    };
    const { room, events } = setup(runner);
    const submitters = [randomUUID(), randomUUID()];
    const spectator = randomUUID();
    const messages = new Map<
      string,
      { type: string; payload?: Record<string, unknown> }[]
    >();
    for (const accountId of [...submitters, spectator]) {
      const received: { type: string; payload?: Record<string, unknown> }[] =
        [];
      messages.set(accountId, received);
      await joinSeated(room, accountId, {
        send: (message) => received.push(message as (typeof received)[number]),
      });
    }
    room.state = {
      ...room.state,
      seats: room.state.seats.map((seat) =>
        seat.accountId === spectator ? { ...seat, presence: 'away' } : seat,
      ),
    };
    await room.persistGameState({});
    const roundId = room.state.round!.roundId;
    for (const accountId of submitters)
      await room.submitAction(accountId, randomUUID(), 'I take an action.');
    await vi.waitFor(() => {
      for (const accountId of submitters)
        expect(
          messages
            .get(accountId)
            ?.some(
              (message) =>
                message.type === 'Error' &&
                message.payload?.code === 'TURN_FAILED' &&
                message.payload?.actionId === roundId,
            ),
        ).toBe(true);
    });
    expect(
      messages.get(spectator)?.some((message) => message.type === 'Error'),
    ).toBe(false);
    expect(room.state.round?.status).toBe('open');
    for (const accountId of submitters)
      await room.submitAction(accountId, randomUUID(), 'Retry the action.');
    await vi.waitFor(() => expect(calls).toBe(2));
    expect(events.some((event) => event.type === 'ActionAccepted')).toBe(true);
    expect(room.state.round?.status).toBe('open');
    await room.drain();
  });

  it('sends a round restriction only to the restricted first actor', async () => {
    const runner: SoloTurnRunner = {
      async run() {
        throw new LiveDmRestrictedError();
      },
    };
    const { room } = setup(runner);
    const restrictedAccount = randomUUID();
    const otherAccount = randomUUID();
    const messagesByAccount = new Map<
      string,
      { type: string; payload?: Record<string, unknown> }[]
    >();
    for (const accountId of [restrictedAccount, otherAccount]) {
      const messages: { type: string; payload?: Record<string, unknown> }[] =
        [];
      messagesByAccount.set(accountId, messages);
      await joinSeated(room, accountId, {
        send: (message) => messages.push(message as (typeof messages)[number]),
      });
    }
    await room.persistGameState({});
    const roundId = room.state.round!.roundId;
    await room.submitAction(restrictedAccount, randomUUID(), 'First action');
    await room.submitAction(otherAccount, randomUUID(), 'Second action');
    await vi.waitFor(() => {
      expect(
        messagesByAccount
          .get(restrictedAccount)
          ?.some((message) => message.payload?.code === 'LIVE_DM_RESTRICTED'),
      ).toBe(true);
    });

    expect(
      messagesByAccount
        .get(otherAccount)
        ?.some((message) => message.payload?.code === 'LIVE_DM_RESTRICTED'),
    ).toBe(false);
    expect(
      messagesByAccount
        .get(otherAccount)
        ?.find((message) => message.type === 'Error')?.payload,
    ).toMatchObject({ code: 'TURN_FAILED', actionId: roundId });
    await room.drain();
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
    await joinSeated(room, owner, { send() {} });
    await joinSeated(room, other, { send() {} });
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
      await joinSeated(room, owner, {
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
    await joinSeated(room, owner, { send() {} });
    await joinSeated(room, bystander, {
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
      await joinSeated(room, owner, { send() {} });
      await joinSeated(room, bystander, {
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
  it('recovers persisted combat-room data without a combat tracker', async () => {
    const { room, store, latestSnapshot } = setup({
      async run() {
        throw new Error('unused');
      },
    });
    await room.persistGameState({
      combatRoom: { entities: [], map: { w: 1, h: 1, cells: [] } },
    });

    const recovered = new Room(store, lease, {
      snapshot: latestSnapshot(),
      events: [],
    });

    expect(recovered.clientState().gameState).toMatchObject({
      combatRoom: { entities: [], map: { w: 1, h: 1, cells: [] } },
    });
  });

  it('tolerates a persisted combat room without a combat tracker', async () => {
    const { room } = setup({
      async run() {
        throw new Error('unused');
      },
    });

    await expect(
      room.persistGameState({
        combatRoom: { entities: [], map: { w: 1, h: 1, cells: [] } },
      }),
    ).resolves.toBeUndefined();
    expect(room.clientState().gameState).toMatchObject({
      combatRoom: { entities: [], map: { w: 1, h: 1, cells: [] } },
    });
  });

  it('Room teardown probe: a once-hidden identity never reaches any viewer, survives restore and rewind', async () => {
    const { room, store, latestSnapshot } = setup({
      async run() {
        throw new Error('unused');
      },
    });
    const actor = randomUUID();
    const other = randomUUID();
    await room.seat(actor, 'Actor', false);
    await room.seat(other, 'Other', false);
    const goblin = { id: 'ent_gob', name: 'Gribble', hidden: true };
    await room.persistGameState({
      combatRoom: { entities: [goblin], map: { w: 1, h: 1, cells: [] } },
    });
    await room.persistGameState({ sceneId: 'later', world: {} }); // teardown: no combatRoom
    const record = [{ id: 'ent_gob', name: 'Gribble' }];
    expect((room.state.gameState as { concealed?: unknown }).concealed).toEqual(
      record,
    );
    for (const viewer of [undefined, actor, other])
      expect(JSON.stringify(room.clientState(viewer))).not.toMatch(
        /Gribble|ent_gob|concealed/,
      );

    const recovered = new Room(store, lease, {
      snapshot: latestSnapshot(),
      events: [],
    });
    expect(
      (recovered.state.gameState as { concealed?: unknown }).concealed,
    ).toEqual(record);
    expect(JSON.stringify(recovered.clientState(other))).not.toMatch(
      /Gribble|ent_gob/,
    );

    // Rewind assigns an older state that predates the concealment: the record never shrinks.
    room.state = { ...room.state, gameState: { sceneId: 'older' } };
    expect((room.state.gameState as { concealed?: unknown }).concealed).toEqual(
      record,
    );
  });

  it('redacts private opt-outs from StateSync in a lobby without game state', async () => {
    const { room } = setup({
      async run() {
        return result as never;
      },
    });
    await room.seat(randomUUID(), 'Opted out', true);
    await room.seat(randomUUID(), 'Opted in', false);

    const state = room.clientState();
    expect(state.gameState).toBeUndefined();
    expect(state.seats).toHaveLength(2);
    expect(state.seats.every((seat) => !('matureOptOut' in seat))).toBe(true);
    expect(JSON.stringify(state)).not.toContain('matureOptOut');
  });

  it('keeps private opt-outs and historical prose out of client StateSync state', async () => {
    const { room } = setup({
      async run() {
        return result as never;
      },
    });
    await room.persistGameState({
      recap: { recap: 'unsafe historical recap', memoryHash: 'h1' },
      sceneSummary: 'unsafe historical scene summary',
      world: { npcs: { npc_a: { name: 'unsafe registry prose' } } },
      gameEngine: {
        world: { rulings: [{ ruling: 'unsafe ruling text' }] },
        turn: 3,
      },
    });
    await room.seat(randomUUID(), 'Private Player', true);

    const state = room.clientState().gameState as Record<string, unknown>;
    expect(state).not.toHaveProperty('recap');
    expect(state).not.toHaveProperty('sceneSummary');
    expect(state).not.toHaveProperty('world');
    expect(room.clientState().seats[0]).not.toHaveProperty('matureOptOut');
    expect(state).not.toHaveProperty('gameEngine');
    expect(JSON.stringify(room.clientState())).not.toContain('unsafe');
  });

  it('does not commit endpoint-error narration or action state', async () => {
    const { room, events, latestSnapshot } = setup({
      async run(_input: unknown, emit: (event: unknown) => void) {
        emit({
          type: 'NarrationCompleted',
          turnId: 'turn',
          text: 'The DM falters.',
          words: 3,
          fallback: 'endpoint-error',
        });
        return { ...result, fallback: 'endpoint-error' } as never;
      },
    });
    const account = randomUUID();
    const sent: { type?: string; payload?: { fallback?: unknown } }[] = [];
    await joinSeated(room, account, {
      send(message: unknown) {
        sent.push(message as (typeof sent)[number]);
      },
    });
    const before = JSON.stringify(latestSnapshot()?.state);
    const storedBefore = events.length;
    expect(await room.submitAction(account, randomUUID(), 'I look.')).toBe(
      true,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sent.some((message) => message.type === 'Error')).toBe(true);
    expect(sent.some((message) => message.type === 'NarrationCompleted')).toBe(
      false,
    );
    expect(events.length).toBe(storedBefore);
    expect(JSON.stringify(latestSnapshot()?.state)).toBe(before);
  });

  it('reloads the head seq after a failed write so the next write does not reuse a seq', async () => {
    const { room, store } = setup({
      async run() {
        throw new Error('unused');
      },
    });
    const original = store.writeTurn.bind(store);
    const seqs: number[] = [];
    let failNext = true;
    store.writeTurn = (async (...args: Parameters<typeof original>) => {
      seqs.push(args[1][0]!.seq);
      if (!failNext) return original(...args);
      failNext = false;
      await original(...args);
      throw new Error('lease fenced after commit');
    }) as typeof store.writeTurn;
    await expect(room.seat(randomUUID(), 'First', false)).rejects.toThrow(
      'lease fenced',
    );
    await room.seat(randomUUID(), 'Second', false);
    expect(seqs).toEqual([1, 2]);
  });

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

  it('projects only UI-required fields from game state and checkpoints', async () => {
    const { room } = setup({
      async run() {
        throw new Error('unused');
      },
    });
    const visible = {
      characters: { player: { name: 'Hero' } },
      combatRoom: { entities: [], map: { w: 1, h: 1, cells: [] } },
    };
    await room.persistGameState({
      ...visible,
      lastNarration: 'secret narration',
      lastPlayerText: 'secret player text',
      sceneSummary: 'secret scene summary',
      world: { registryText: 'secret registry prose' },
      recap: { recap: 'secret recap', memoryHash: 'secret hash' },
      gameEngine: {
        turn: 3,
        world: { rulings: [{ ruling: 'secret engine registry prose' }] },
      },
      failForward: { narrative: 'secret player-provided prose' },
      madeUpFutureKey: 'secret future prose',
    });
    await room.saveCheckpoint();
    const clientGameState = room.clientState().gameState as Record<
      string,
      unknown
    >;
    const checkpoint = clientGameState.checkpoint as Record<string, unknown>;
    const expectedVisibleFields = ['characters', 'combatRoom'];
    expect(Object.keys(clientGameState).sort()).toEqual(
      [...expectedVisibleFields, 'checkpoint'].sort(),
    );
    expect(Object.keys(checkpoint).sort()).toEqual(expectedVisibleFields);
    expect(clientGameState.characters).toEqual(visible.characters);
    expect(clientGameState.combatRoom).toEqual(visible.combatRoom);
    expect(checkpoint.characters).toEqual(visible.characters);
    expect(checkpoint.combatRoom).toEqual(visible.combatRoom);
    expect(JSON.stringify(room.clientState())).not.toContain('secret');
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
    await joinSeated(room, account, { send() {} });
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
    await joinSeated(room, account, { send() {} });
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
    await joinSeated(room, account, {
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

  it('commits a turn already in flight when drain begins', async () => {
    const { runner, finish } = gatedRunner();
    const { room, events } = setup(runner);
    const account = randomUUID();
    await joinSeated(room, account, { send() {} });
    await room.submitAction(account, randomUUID(), 'I wait.');
    const draining = room.drain();
    await new Promise((resolve) => setTimeout(resolve, 0));
    finish();
    await draining;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events.map((event) => event.type)).toContain('ActionAccepted');
  });

  it('rejects new player submissions once drain starts', async () => {
    const { runner, finish } = gatedRunner();
    const { room } = setup(runner);
    const account = randomUUID();
    await joinSeated(room, account, { send() {} });
    expect(await room.submitAction(account, randomUUID(), 'I wait.')).toBe(
      true,
    );
    const draining = room.drain();
    await expect(
      room.submitAction(account, randomUUID(), 'Me too.'),
    ).rejects.toThrow(/draining/);
    finish();
    await draining;
  });

  it('stops waiting for a turn that outlives the drain deadline', async () => {
    const { runner } = gatedRunner();
    const { room } = setup(runner);
    const account = randomUUID();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await joinSeated(room, account, { send() {} });
    await room.submitAction(account, randomUUID(), 'I wait.');
    await room.drain(20);
    await expect(room.submit(randomUUID())).rejects.toThrow(/draining/);
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/deadline/));
    error.mockRestore();
  });

  it('keeps a character change from the turn when combat advances during narration', async () => {
    const { state: combat, game } = bootstrapped();
    const aria = combat.entities.find((e) => e.id === hero.id)!;
    const moved = {
      ...combat,
      entities: combat.entities.map((e) =>
        e.id === hero.id
          ? { ...e, pos: { x: aria.pos.x + 1, y: aria.pos.y } }
          : e,
      ),
    };
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const fixture: { room?: Room } = {};
    const runner: SoloTurnRunner = {
      async run(request) {
        await gate;
        fixture.room!.state = {
          ...fixture.room!.state,
          gameState: {
            ...(fixture.room!.state.gameState as object),
            combatRoom: moved,
          } as never,
        };
        const characters = request.state.characters as Record<string, object>;
        const hurt = {
          ...hero,
          hp: { ...hero.hp, current: hero.hp.current - 4 },
        };
        return {
          ...result,
          state: {
            ...request.state,
            characters: { ...characters, [combatAccount]: hurt },
          },
        } as never;
      },
    };
    const { room, latestSnapshot } = setup(runner);
    fixture.room = room;
    room.state = { ...room.state, gameState: game };
    await joinSeated(room, combatAccount, { send() {} });
    expect(
      await room.submitAction(combatAccount, randomUUID(), 'I charge.'),
    ).toBe(true);
    finish();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const saved = latestSnapshot()?.state as {
      gameState: {
        characters: Record<string, { hp: { current: number } }>;
        combatRoom: {
          entities: { id: string; pos: { x: number }; hp: number }[];
        };
      };
    };
    expect(saved.gameState.characters[combatAccount]?.hp.current).toBe(
      hero.hp.current - 4,
    );
    expect(
      saved.gameState.combatRoom.entities.find((e) => e.id === hero.id)?.pos.x,
    ).toBe(aria.pos.x + 1);
  });

  it('does not start a queued LLM turn once drain begins', async () => {
    let calls = 0;
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const runner: SoloTurnRunner = {
      async run() {
        calls += 1;
        await gate;
        return result as never;
      },
    };
    const { room } = setup(runner);
    const account = randomUUID();
    await joinSeated(room, account, { send() {} });
    expect(await room.submitAction(account, randomUUID(), 'one')).toBe(true);
    expect(await room.submitAction(account, randomUUID(), 'two')).toBe(true);
    const draining = room.drain();
    await new Promise((resolve) => setTimeout(resolve, 0));
    finish();
    await draining;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toBe(1);
  });

  it('tells a queued player their action is dropped when drain begins', async () => {
    const { runner, finish } = gatedRunner();
    const { room } = setup(runner);
    const messages: { type: string; payload?: unknown }[] = [];
    const account = randomUUID();
    await joinSeated(room, account, {
      send: (message) => messages.push(message as never),
    });
    const queued = randomUUID();
    expect(await room.submitAction(account, randomUUID(), 'one')).toBe(true);
    expect(await room.submitAction(account, queued, 'two')).toBe(true);
    const draining = room.drain();
    finish();
    await draining;
    expect(messages).toContainEqual(
      expect.objectContaining({
        type: 'ActionWithdrawn',
        payload: { actionId: queued },
      }),
    );
    expect(room['pendingActions'].has(queued)).toBe(false);
  });
});

describe('Room turn HP merge', () => {
  type SavedGame = {
    characters: Record<string, { hp: { current: number; temp: number } }>;
    combatRoom: {
      entities: { id: string; hp: number }[];
      concentration?: Record<string, string | null>;
    };
  };

  async function commitHeroTurn(
    startHp: number,
    turnHp: { current: number; temp: number },
    concentrating = false,
  ) {
    const { state: combat, game } = bootstrapped();
    const combatRoom = {
      ...combat,
      entities: combat.entities.map((e) =>
        e.id === hero.id ? { ...e, hp: startHp } : e,
      ),
      ...(concentrating && { concentration: { [hero.id]: 'srd:spell/bless' } }),
    };
    const runner: SoloTurnRunner = {
      async run(request) {
        const characters = request.state.characters as Record<string, object>;
        return {
          ...result,
          state: {
            ...request.state,
            characters: {
              ...characters,
              [combatAccount]: { ...hero, hp: { ...hero.hp, ...turnHp } },
            },
          },
        } as never;
      },
    };
    const { room, events, latestSnapshot } = setup(runner);
    room.state = {
      ...room.state,
      gameState: {
        ...(game as object),
        characters: {
          [combatAccount]: { ...hero, hp: { ...hero.hp, current: startHp } },
        },
        combatRoom,
      } as never,
    };
    await joinSeated(room, combatAccount, { send() {} });
    expect(await room.submitAction(combatAccount, randomUUID(), 'I act.')).toBe(
      true,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    const saved = (latestSnapshot()?.state as { gameState: SavedGame })
      .gameState;
    return { events, saved };
  }

  it('makes exactly one concentration save when a turn damages a concentrating character', async () => {
    const { events, saved } = await commitHeroTurn(
      30,
      { current: 26, temp: 0 },
      true,
    );
    const saves = events.filter(
      (event) =>
        event.type === 'RollEvent' &&
        (event.payload as { kind?: string }).kind === 'save',
    );
    expect(saves).toHaveLength(1);
    const dropped = events.some(
      (event) => event.type === 'ConcentrationDropped',
    );
    expect(saved.combatRoom.concentration?.[hero.id] ?? null).toBe(
      dropped ? null : 'srd:spell/bless',
    );
  });

  it('keeps healing and temp HP from a turn through the combat merge', async () => {
    const { saved } = await commitHeroTurn(20, { current: 25, temp: 3 });
    expect(saved.characters[combatAccount]?.hp).toMatchObject({
      current: 25,
      temp: 3,
    });
    expect(saved.combatRoom.entities.find((e) => e.id === hero.id)?.hp).toBe(
      25,
    );
  });

  it('keeps a character at 0 HP and ends concentration without a save', async () => {
    const { events, saved } = await commitHeroTurn(
      4,
      { current: 0, temp: 0 },
      true,
    );
    expect(saved.characters[combatAccount]?.hp.current).toBe(0);
    expect(saved.combatRoom.entities.find((e) => e.id === hero.id)?.hp).toBe(0);
    expect(saved.combatRoom.concentration?.[hero.id] ?? null).toBeNull();
    expect(
      events.filter(
        (event) =>
          event.type === 'RollEvent' &&
          (event.payload as { kind?: string }).kind === 'save',
      ),
    ).toHaveLength(0);
  });
});
