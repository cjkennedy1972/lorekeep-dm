import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  Room,
  RoomSeatRequiredError,
  type RoomStore,
} from '../../src/room/Room.js';
import type { CombatRuntime } from '../../src/room/combat.js';
import type { SoloTurnRunner } from '../../src/room/dmTurn.js';
import type { StoredEvent } from '../../src/persistence/index.js';
import { seatEntityId } from '../../src/room/seatEntity.js';

const sessionId = randomUUID();
const lease = {
  sessionId,
  nodeId: 'node',
  epoch: 1,
  expiresAt: new Date(Date.now() + 60_000),
};
const runner = { async run() {} } as unknown as SoloTurnRunner;

function party(
  options: {
    bindA?: boolean;
    bindB?: boolean;
    partyMode?: boolean;
    gameState?: (seatA: string) => unknown;
    round?: (seatA: string, seatB: string) => unknown;
    runtime?: CombatRuntime;
    hostA?: boolean;
    roundsEnabled?: boolean;
    turnRunner?: SoloTurnRunner;
    failBindingReload?: boolean;
    ownerBindingOnConversion?: boolean;
  } = {},
) {
  const [accountA, accountB, seatA, seatB] = [1, 2, 3, 4].map(() =>
    randomUUID(),
  );
  const writes: {
    events: string[];
    transition: unknown;
    mode: unknown;
    ownerReturn: boolean;
  }[] = [];
  const stored: StoredEvent[] = [];
  const store = {
    async loadLatest() {
      return { snapshot: null, events: [] };
    },
    async loadActiveSeatCharacterBindings() {
      if (options.failBindingReload)
        throw new Error('simulated reload failure');
      return [];
    },
    async writeTurn(
      _id: string,
      inputs: StoredEvent[],
      _state: unknown,
      _lease: unknown,
      _a: unknown,
      _b: unknown,
      _c: unknown,
      _d: unknown,
      transition: unknown,
      sessionModeTransition: unknown,
    ) {
      writes.push({
        events: inputs.map((i) => i.type),
        transition,
        mode: sessionModeTransition,
      });
      const out = inputs.map((input, index) => ({
        ...input,
        seq: stored.length + index + 1,
        sessionId,
        ts: new Date(),
      })) as StoredEvent[];
      stored.push(...out);
      const bind = (transition ?? {}) as {
        kind?: string;
        seatId?: string;
        accountId?: string;
      };
      const result = {
        events: out,
        ...(bind.kind === 'bind'
          ? {
              binding: {
                seatId: bind.seatId!,
                accountId: bind.accountId!,
                characterSnapshot: { name: 'Committed sheet' },
              },
            }
          : {}),
        ...(options.ownerBindingOnConversion &&
        sessionModeTransition === 'solo-to-party'
          ? {
              ownerBinding: {
                seatId: seatA,
                accountId: accountA,
                characterSnapshot: { name: 'Owner legacy sheet' },
              },
            }
          : {}),
      };
      writes.at(-1)!.ownerReturn = Boolean(result.ownerBinding);
      return result;
    },
    async isTableHost(_id: string, accountId: string) {
      return options.hostA === true && accountId === accountA;
    },
  } as unknown as RoomStore;
  const secret = { name: 'Secret sheet name' };
  const bindings = [
    ...(options.bindA === false
      ? []
      : [{ seatId: seatA, accountId: accountA, characterSnapshot: secret }]),
    ...(options.bindB
      ? [{ seatId: seatB, accountId: accountB, characterSnapshot: secret }]
      : []),
  ];
  const seat = (seatId: string, accountId: string) => ({
    seatId,
    accountId,
    displayName: accountId.slice(0, 4),
    presence: 'connected' as const,
  });
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
          ...(options.roundsEnabled ? { roundsEnabled: true } : {}),
          seats: [seat(seatA, accountA), seat(seatB, accountB)],
          gameState: options.gameState?.(seatA) ?? {},
          ...(options.round ? { round: options.round(seatA, seatB) } : {}),
        },
      },
      events: [],
    },
    options.turnRunner ?? runner,
    options.runtime,
    bindings,
    options.partyMode ?? true,
  );
  return { room, writes, stored, accountA, accountB, seatA, seatB };
}

describe('ADR-035 party seat gating', () => {
  it('keeps the solo owner able to submit an action while a late join awaits binding', async () => {
    const f = party({
      partyMode: false,
      bindA: false,
      ownerBindingOnConversion: true,
    });
    const requestId = randomUUID();
    const requester = randomUUID();
    f.room.state = {
      ...f.room.state,
      lateJoinRequests: [
        {
          requestId,
          accountId: requester,
          displayName: 'Late player',
          approved: true,
          expiresAt: Date.now() + 60_000,
          characterId: randomUUID(),
          expectedRevision: 1,
        },
      ],
    } as never;
    await (
      f.room as unknown as { admitApprovedLateJoins(): Promise<void> }
    ).admitApprovedLateJoins();

    expect(f.writes).toContainEqual(
      expect.objectContaining({ events: ['SeatJoined'], ownerReturn: false }),
    );
    expect(f.writes[0]?.mode).toBeUndefined();
    await expect(
      f.room.submitAction(f.accountA, randomUUID(), 'I take my turn.'),
    ).resolves.toBe(true);
  });
  it('keeps clarification details out of StateSync and replays them only to the owner', async () => {
    const f = party();
    const actionId = randomUUID();
    f.room.state.openClarifications = {
      [actionId]: {
        accountId: f.accountA,
        playerName: 'Owner',
        text: 'private player text',
        question: 'Which door?',
        deadlineAt: Date.now() + 60_000,
      },
    } as never;

    const guestMessages: Record<string, unknown>[] = [];
    await f.room.subscribe(f.accountB, {
      send(message: Record<string, unknown>) {
        guestMessages.push(message);
      },
    });
    const guestSync = guestMessages.find(
      (message) => message.type === 'StateSync',
    )!;
    expect(guestSync.payload).not.toHaveProperty('state.openClarifications');
    expect(JSON.stringify(guestSync)).not.toContain('private player text');

    await f.room.subscribe(f.accountA, { send() {} });
    await f.room.disconnect(f.accountA);

    const ownerMessages: Record<string, unknown>[] = [];
    await f.room.subscribe(f.accountA, {
      send(message: Record<string, unknown>) {
        ownerMessages.push(message);
      },
    });
    expect(ownerMessages).toContainEqual(
      expect.objectContaining({
        type: 'ClarificationRequested',
        payload: { actionId, question: 'Which door?' },
      }),
    );
  });
  it('omits bound seat identifiers from solo and empty-party StateSync payloads', async () => {
    for (const options of [
      { partyMode: false, bindA: false, bindB: false },
      { partyMode: true, bindA: false, bindB: false },
    ]) {
      const f = party(options);
      const messages: Record<string, unknown>[] = [];
      await f.room.subscribe(f.accountA, {
        send(message: Record<string, unknown>) {
          messages.push(message);
        },
      });
      const sync = messages.find((message) => message.type === 'StateSync')!;
      expect(sync.payload).not.toHaveProperty('boundSeatIds');
    }
  });

  it('excludes a revoked seat while retaining another bound seat in StateSync', async () => {
    const f = party({ bindB: true, hostA: true });
    await f.room.kickSeat(f.accountA, randomUUID(), f.seatB);
    const messages: Record<string, unknown>[] = [];
    await f.room.subscribe(f.accountA, {
      send(message: Record<string, unknown>) {
        messages.push(message);
      },
    });
    const sync = messages.find((message) => message.type === 'StateSync')!;
    expect(sync.payload).toHaveProperty('boundSeatIds', [f.seatA]);
  });

  it('includes only active bound seat identifiers in reconnect StateSync', async () => {
    const f = party({ bindA: false, bindB: true });
    await f.room.bindSeatCharacter(
      f.accountA,
      randomUUID(),
      1,
      async () => true,
      randomUUID(),
    );
    const messages: Record<string, unknown>[] = [];
    const connection = {
      send(message: Record<string, unknown>) {
        messages.push(message);
      },
    };
    await f.room.subscribe(f.accountA, connection);
    const sync = messages.find((message) => message.type === 'StateSync')!;
    expect(
      (sync.payload as { boundSeatIds: string[] }).boundSeatIds.toSorted(),
    ).toEqual([f.seatA, f.seatB].toSorted());
    expect(JSON.stringify(sync)).not.toContain('Secret sheet name');
    expect(JSON.stringify(sync)).not.toContain('characterSnapshot');

    await f.room.leave(f.accountB);
    const afterRelease: Record<string, unknown>[] = [];
    await f.room.subscribe(f.accountA, {
      send(message: Record<string, unknown>) {
        afterRelease.push(message);
      },
    });
    expect(
      (
        afterRelease.find((message) => message.type === 'StateSync')!
          .payload as { boundSeatIds: string[] }
      ).boundSeatIds,
    ).toEqual([f.seatA]);
  });

  it('includes only active bound seats in a RESYNC StateSync', async () => {
    const f = party({ bindB: true, hostA: true });
    await f.room.kickSeat(f.accountA, randomUUID(), f.seatB);
    const messages: Record<string, unknown>[] = [];
    await f.room.subscribe(
      f.accountA,
      { send: (message) => messages.push(message) },
      -1,
    );

    const sync = messages.find((message) => message.type === 'StateSync')!;
    expect(sync.payload).toHaveProperty('boundSeatIds', [f.seatA]);

    const empty = party({ bindA: false, bindB: false });
    const emptyMessages: Record<string, unknown>[] = [];
    await empty.room.subscribe(
      empty.accountA,
      {
        send: (message) => emptyMessages.push(message),
      },
      -1,
    );
    expect(
      emptyMessages.find((message) => message.type === 'StateSync')!.payload,
    ).not.toHaveProperty('boundSeatIds');
  });

  it('includes active bound seats in the round StateSync and excludes released seats', async () => {
    const f = party({
      bindB: true,
      roundsEnabled: true,
      round: (seatA, seatB) => ({
        roundId: randomUUID(),
        status: 'open',
        eligibleSeatIds: [seatA, seatB],
        deadlineAt: null,
        submissions: [],
        queuedSubmissions: [],
      }),
    });
    await f.room.leave(f.accountB);
    const messages: Record<string, unknown>[] = [];
    await f.room.join(
      f.accountA,
      { send: (message) => messages.push(message) },
      'A',
      false,
      -1,
      { requireExistingSeat: true },
    );

    const sync = messages.find((message) => message.type === 'StateSync')!;
    expect(sync.payload).toHaveProperty('boundSeatIds', [f.seatA]);
    expect(sync.payload).toHaveProperty('round');

    const empty = party({
      bindA: false,
      bindB: false,
      roundsEnabled: true,
      round: (seatA) => ({
        roundId: randomUUID(),
        status: 'open',
        eligibleSeatIds: [seatA],
        deadlineAt: null,
        submissions: [],
        queuedSubmissions: [],
      }),
    });
    const emptyMessages: Record<string, unknown>[] = [];
    await empty.room.join(
      empty.accountA,
      { send: (message) => emptyMessages.push(message) },
      'A',
      false,
      -1,
      { requireExistingSeat: true },
    );
    expect(
      emptyMessages.find((message) => message.type === 'StateSync')!.payload,
    ).not.toHaveProperty('boundSeatIds');
  });

  it('rejects round actions from an unbound seat', async () => {
    const { room, accountA, accountB } = party();
    await expect(
      room.submitAction(accountB, randomUUID(), 'I attack'),
    ).rejects.toBeInstanceOf(RoomSeatRequiredError);
    await expect(
      room.submitAction(accountA, randomUUID(), 'I look around'),
    ).resolves.toBe(true);
  });

  it('resolves the combat actor from the bound seat and rejects unbound seats', async () => {
    const calls: { actorId: string; character: unknown }[] = [];
    const runtime = {
      execute(
        _s: unknown,
        actorId: string,
        _c: unknown,
        ctx?: { character?: unknown },
      ) {
        calls.push({ actorId, character: ctx?.character });
        return { code: 'COMMAND_REJECTED', message: 'stub' };
      },
    } as unknown as CombatRuntime;
    const f = party({
      runtime,
      gameState: (seatA) => ({
        combatRoom: {
          ended: false,
          entities: [{ id: seatEntityId(seatA) }],
          combat: { activeEntityId: seatEntityId(seatA), initiative: [] },
        },
      }),
    });
    await expect(
      f.room.submitCombatCommand(f.accountB, randomUUID(), {
        command: 'end-turn',
      }),
    ).rejects.toBeInstanceOf(RoomSeatRequiredError);
    expect(calls).toEqual([]);
    await f.room.submitCombatCommand(f.accountA, randomUUID(), {
      command: 'end-turn',
    });
    expect(calls).toEqual([
      {
        actorId: seatEntityId(f.seatA),
        character: { name: 'Secret sheet name', id: seatEntityId(f.seatA) },
      },
    ]);
  });

  it('releases a just-committed binding even if the follow-up binding reload fails', async () => {
    const f = party({ bindA: false, failBindingReload: true });
    await f.room.bindSeatCharacter(
      f.accountA,
      randomUUID(),
      1,
      async () => true,
      randomUUID(),
    );
    expect(f.room.seatCharacters.get(f.seatA)).toMatchObject({
      accountId: f.accountA,
      characterSnapshot: { name: 'Committed sheet' },
    });
    await f.room.leave(f.accountA);
    const revoke = f.writes.find((write) =>
      write.events.includes('SeatRevoked'),
    )!;
    expect(revoke.events).toEqual(['SeatRevoked', 'SeatCharacterReleased']);
    expect(revoke.transition).toMatchObject({
      kind: 'release',
      seatId: f.seatA,
    });
  });

  it('does not reveal a character when a different viewer id matches the seat id', () => {
    const f = party({ bindB: true });
    const privateSheet = { name: 'Owner-only sheet', privateNotes: 'private' };
    f.room.state.gameState = { characters: { [f.seatA]: privateSheet } };
    const projection = f.room.clientState(f.seatA).gameState as {
      characters: Record<string, Record<string, unknown>>;
    };
    expect(projection.characters[f.seatA]).not.toHaveProperty('privateNotes');
  });

  it('leave releases the binding atomically with an identifier-only event', async () => {
    const { room, writes, accountA, seatA } = party({ bindB: true });
    expect(room.seatCharacters.has(seatA)).toBe(true);
    await room.leave(accountA);
    const write = writes.find((w) => w.events.includes('SeatRevoked'))!;
    expect(write.events).toEqual(['SeatRevoked', 'SeatCharacterReleased']);
    expect(write.transition).toMatchObject({ kind: 'release', seatId: seatA });
    expect(room.seatCharacters.has(seatA)).toBe(false);
    expect(JSON.stringify(room.clientState())).not.toContain(
      'Secret sheet name',
    );
  });

  it('does not allow a replacement account to use the previous account binding', async () => {
    const f = party({ bindA: true });
    const replacement = randomUUID();
    f.room.state.seats.find((seat) => seat.seatId === f.seatA)!.accountId =
      replacement;
    await expect(
      f.room.submitAction(replacement, randomUUID(), 'use inherited sheet'),
    ).rejects.toBeInstanceOf(RoomSeatRequiredError);
  });

  it('projects a public card to other seats while the owner retains their own sheet', () => {
    const f = party({ bindB: true });
    const privateSheet = {
      id: randomUUID(),
      name: 'Hero',
      speciesId: 'species:human',
      classId: 'class:cleric',
      level: 3,
      hp: { current: 8, max: 20, temp: 0 },
      privateNotes: 'secret history',
      backstory: 'private backstory',
    };
    f.room.state.gameState = {
      characters: { [f.seatA]: privateSheet, [f.seatB]: privateSheet },
    };
    const other = f.room.clientState(f.accountB).gameState as {
      characters: Record<string, Record<string, unknown>>;
    };
    const own = f.room.clientState(f.accountA).gameState as {
      characters: Record<string, Record<string, unknown>>;
    };
    expect(other.characters[f.seatA]).toEqual({
      id: privateSheet.id,
      name: 'Hero',
      speciesId: 'species:human',
      classId: 'class:cleric',
      level: 3,
      hp: { current: 8, max: 20 },
    });
    expect(other.characters[f.seatA]).not.toHaveProperty('privateNotes');
    expect(own.characters[f.seatA]).toEqual(privateSheet);

    const solo = party({ bindA: false, partyMode: false });
    solo.room.state.gameState = {
      characters: { [solo.accountA]: privateSheet },
    };
    expect(
      (
        solo.room.clientState(solo.accountA).gameState as {
          characters: Record<string, unknown>;
        }
      ).characters[solo.accountA],
    ).toEqual(privateSheet);
  });

  it.each(['leave', 'kick'] as const)(
    '%s withdraws a round action and closes its clarification before revocation',
    async (departure) => {
      const dmCalls: string[] = [];
      const f = party({
        bindB: true,
        hostA: true,
        roundsEnabled: true,
        turnRunner: {
          async run(request) {
            dmCalls.push(request.text);
            return undefined as never;
          },
        } as unknown as SoloTurnRunner,
      });
      const actionId = randomUUID();
      await f.room.submitAction(f.accountB, actionId, 'withdraw me', 'B');
      const clarificationId = randomUUID();
      f.room.state.openClarifications = {
        [clarificationId]: {
          accountId: f.accountB,
          playerName: 'B',
          text: 'question',
          question: 'Which?',
          deadlineAt: Date.now() + 60_000,
        },
      } as never;
      if (departure === 'leave') await f.room.leave(f.accountB);
      else await f.room.kickSeat(f.accountA, randomUUID(), f.seatB);
      expect(
        (f.room.state.round?.submissions ?? []).some(
          (submission) => submission.seatId === f.seatB,
        ),
      ).toBe(false);
      expect(
        f.room.state.openClarifications?.[clarificationId],
      ).toBeUndefined();
      expect(
        f.writes.some((write) => write.events.includes('RoundActionWithdrawn')),
      ).toBe(true);
      expect(
        f.writes.some((write) => write.events.includes('RoundResolved')),
      ).toBe(false);
      expect(dmCalls).toEqual([]);
      expect(
        f.writes.some((write) => write.events.includes('ClarificationClosed')),
      ).toBe(true);
    },
  );

  it('filters a submission if its binding is revoked before round close', async () => {
    const f = party({ bindB: true });
    const actionId = randomUUID();
    f.room.state.round = {
      roundId: randomUUID(),
      status: 'open',
      eligibleSeatIds: [f.seatB],
      deadlineAt: Date.now() + 60_000,
      queuedSubmissions: [],
      submissions: [
        {
          seatId: f.seatB,
          accountId: f.accountB,
          actionId,
          originalActionId: actionId,
          actionIds: [actionId],
          text: 'must not reach DM',
          playerName: 'B',
          receiptSeq: 1,
        },
      ],
    } as never;
    f.room.state.paused = false;
    f.room.state.seats = f.room.state.seats.filter(
      (seat) => seat.seatId !== f.seatB,
    );
    f.room.seatCharacters.delete(f.seatB);
    await (
      f.room as unknown as { resolveRound(reason: 'timer'): Promise<void> }
    ).resolveRound('timer');
    expect(f.stored.some((event) => event.type === 'RoundResolved')).toBe(
      false,
    );
    expect(f.stored.some((event) => event.type === 'RoundClosedEmpty')).toBe(
      true,
    );
  });

  it('rejects clarification answers and TPK choices from revoked or unbound accounts', async () => {
    const f = party({ bindB: true });
    await f.room.leave(f.accountB);
    expect(
      await f.room.answerClarification(f.accountB, randomUUID(), 'answer'),
    ).toBe(false);
    const unbound = party({ bindB: false });
    await expect(
      unbound.room.chooseTpkResolution(unbound.accountB, 'fail-forward'),
    ).rejects.toBeInstanceOf(RoomSeatRequiredError);
  });

  it('runs seat release on leave in a solo session without a binding', async () => {
    const { room, writes, accountA } = party({
      bindA: false,
      partyMode: false,
    });
    await room.leave(accountA);
    expect(writes.at(-1)?.events).toContain('SeatRevoked');
    expect(writes.at(-1)?.transition).toMatchObject({ kind: 'release' });
  });

  it('attempts an account-scoped release when a seat was never bound in memory', async () => {
    const { room, writes, accountB, seatB } = party();
    await room.leave(accountB);
    expect(writes.at(-1)?.events).toEqual([
      'SeatRevoked',
      'SeatCharacterReleased',
    ]);
    expect(writes.at(-1)?.transition).toMatchObject({
      kind: 'release',
      seatId: seatB,
      accountId: accountB,
    });
  });

  it('gates every party session even when no seat is bound', async () => {
    const f = party({ bindA: false });
    for (const account of [f.accountA, f.accountB]) {
      await expect(
        f.room.submitAction(account, randomUUID(), 'hi'),
      ).rejects.toBeInstanceOf(RoomSeatRequiredError);
      await expect(
        f.room.editAction(account, randomUUID(), randomUUID(), 'x'),
      ).rejects.toBeInstanceOf(RoomSeatRequiredError);
      await expect(
        f.room.withdrawRoundAction(account, randomUUID(), randomUUID()),
      ).rejects.toBeInstanceOf(RoomSeatRequiredError);
      await expect(f.room.takeRest(account, 'short')).rejects.toThrow();
      await expect(
        f.room.chooseTpkResolution(account, 'fail-forward'),
      ).rejects.toBeInstanceOf(RoomSeatRequiredError);
      await expect(
        f.room.submitCombatCommand(account, randomUUID(), {
          command: 'end-turn',
        }),
      ).rejects.toBeInstanceOf(RoomSeatRequiredError);
    }
  });

  it('keeps single-player sessions unchanged by deriving party mode from the session, not bindings', async () => {
    const f = party({ bindA: false, partyMode: false });
    await expect(
      f.room.submitAction(f.accountA, randomUUID(), 'I look around'),
    ).resolves.toBe(true);
  });

  it('restores bindings after restart and still derives the same entity id', async () => {
    const f = party();
    const restarted = new Room(
      {
        async loadLatest() {
          return { snapshot: null, events: [] };
        },
      } as unknown as RoomStore,
      lease,
      { snapshot: null, events: [] },
      runner,
      undefined,
      [...f.room.seatCharacters.values()],
      true,
    );
    expect(restarted.seatCharacters.has(f.seatA)).toBe(true);
    expect(seatEntityId(f.seatA)).toBe(`ent_seat_${f.seatA}`);
  });

  it('declines a released seat reaction at once instead of waiting for the timer', async () => {
    const calls: { actorId: string; command: unknown }[] = [];
    const runtime = {
      execute(_s: unknown, actorId: string, command: unknown) {
        calls.push({ actorId, command });
        return { code: 'COMMAND_REJECTED', message: 'stub' };
      },
      expire(state: Record<string, unknown>) {
        return {
          state: { ...state, pendingReaction: undefined },
          events: [],
        };
      },
    } as unknown as CombatRuntime;
    const f = party({
      runtime,
      bindB: true,
      gameState: (seatA) => ({
        combatRoom: {
          ended: false,
          entities: [{ id: seatEntityId(seatA) }],
          combat: { activeEntityId: 'goblin', initiative: [] },
          pendingReaction: {
            reactionId: 'r1',
            entityId: seatEntityId(seatA),
            deadlineAt: Date.now() + 60_000,
          },
        },
      }),
    });
    await f.room.leave(f.accountA);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls[0]).toMatchObject({
      actorId: seatEntityId(f.seatA),
      command: { command: 'reaction', choice: 'decline' },
    });
  });
});

describe('combatRoom per-viewer projection (ADR-034 §3, ADR-035)', () => {
  const HIDDEN_POS = { x: 7, y: 9 };
  async function twoSeatCombat() {
    const f = party({ bindB: true });
    const [entA, entB] = [seatEntityId(f.seatA), seatEntityId(f.seatB)];
    f.room.state.gameState = {
      characters: {
        [f.seatA]: { id: entA, name: 'A', hp: { current: 5, max: 9 } },
        [f.seatB]: { id: entB, name: 'B', hp: { current: 5, max: 9 } },
      },
      combatRoom: {
        seed: 424242,
        engineReactions: { r: { secret: 'engine-continuation' } },
        entities: [
          {
            id: entA,
            kind: 'character',
            team: 'party',
            ac: 15,
            abilities: { str: 17 },
            saves: { dex: 6 },
            attacks: [{ id: 'atk-secret' }],
            hp: 5,
            maxHp: 9,
            pos: { x: 1, y: 1 },
          },
          {
            id: entB,
            kind: 'character',
            team: 'party',
            hp: 5,
            maxHp: 9,
            pos: { x: 2, y: 1 },
          },
          {
            id: 'goblin',
            kind: 'monster',
            team: 'foe',
            hp: 7,
            maxHp: 7,
            pos: { x: 4, y: 4 },
          },
          {
            id: 'rogue',
            hidden: true,
            kind: 'monster',
            team: 'foe',
            hp: 11,
            maxHp: 11,
            pos: HIDDEN_POS,
          },
        ],
        combat: {
          round: 1,
          activeEntityId: entA,
          initiative: [entA, 'rogue', entB, 'goblin'].map((entityId, i) => ({
            entityId,
            total: 20 - i,
          })),
          resources: { [entA]: {}, rogue: {}, [entB]: {}, goblin: {} },
        },
        pendingReaction: {
          reactionId: 'r',
          entityId: 'rogue',
          trigger: 't',
          moverId: entA,
          deadlineAt: 1,
        },
      },
    };
    const seen = async (accountId: string) => {
      const messages: Record<string, unknown>[] = [];
      await f.room.subscribe(accountId, {
        send: (m: Record<string, unknown>) => void messages.push(m),
      });
      return messages;
    };
    return { f, entA, entB, seen };
  }

  it('never sends a hidden entity (pos, hp, id, reaction) in StateSync or CombatTracker', async () => {
    const { f, seen } = await twoSeatCombat();
    for (const account of [f.accountA, f.accountB]) {
      const wire = JSON.stringify(await seen(account));
      expect(wire).not.toContain('rogue');
      expect(wire).not.toContain('"x":7');
      expect(wire).toContain('goblin');
      expect(wire).not.toContain('"hp":7');
      expect(wire).not.toContain('"maxHp":7');
      expect(wire).toContain('"hpState":"healthy"');
    }
    // server-side authoritative state is unchanged
    expect(JSON.stringify(f.room.state.gameState)).toContain('rogue');
  });

  it('gives other seats only the public PC set, the controller its full sheet', async () => {
    const { f, entA, entB, seen } = await twoSeatCombat();
    const own = JSON.stringify(await seen(f.accountA));
    expect(own).toContain('atk-secret');
    expect(own).toContain('"ac":15');
    const other = JSON.stringify(await seen(f.accountB));
    for (const secret of ['atk-secret', '"ac":15', '"str":17', '"dex":6'])
      expect(other).not.toContain(secret);
    const projected = (
      f.room.clientState(f.accountB).gameState as {
        combatRoom: {
          entities: {
            id: string;
            maxHp?: number;
            hp?: number;
            hpState?: string;
          }[];
        };
      }
    ).combatRoom.entities;
    const otherCharacter = projected.find((entity) => entity.id === entA);
    const ownCharacter = projected.find((entity) => entity.id === entB);
    const monster = projected.find((entity) => entity.id === 'goblin');
    expect(otherCharacter).toHaveProperty('hp', 5);
    expect(otherCharacter).toHaveProperty('maxHp', 9);
    expect(otherCharacter).toHaveProperty('hpState', 'healthy');
    expect(ownCharacter).toHaveProperty('maxHp', 9);
    expect(monster).not.toHaveProperty('hp');
    expect(monster).not.toHaveProperty('maxHp');
    expect(monster).toHaveProperty('hpState', 'healthy');
    const otherCards = (
      f.room.clientState(f.accountB).gameState as {
        characters: Record<string, { hp?: { current?: number; max?: number } }>;
      }
    ).characters;
    expect(otherCards[f.seatA]?.hp).toEqual({ current: 5, max: 9 });
  });

  it('shows a hidden entity only to its controller', async () => {
    const { f, entA, seen } = await twoSeatCombat();
    const state = f.room.state.gameState as {
      characters: Record<string, { id: string }>;
      combatRoom: { entities: { id: string; hidden?: boolean }[] };
    };
    state.characters[f.seatA]!.id = 'rogue';
    state.combatRoom.entities.find((e) => e.id === entA)!.id = 'rogue-pc';
    state.combatRoom.entities.find((e) => e.id === 'rogue')!.hidden = true;
    const tracker = (messages: Record<string, unknown>[]) =>
      JSON.stringify(messages.find((m) => m.type === 'CombatTracker'));
    // reconnect snapshot: controller's tracker carries its own hidden entity, the other seat's does not
    const prompts = (messages: Record<string, unknown>[]) =>
      messages.filter((m) => m.type === 'ReactionPrompt');
    expect(prompts(await seen(f.accountA))).toHaveLength(1);
    expect(prompts(await seen(f.accountB))).toHaveLength(0);
    expect(tracker(await seen(f.accountA))).toContain('"x":7');
    expect(tracker(await seen(f.accountB))).not.toContain('"x":7');
    expect(JSON.stringify(await seen(f.accountA))).toContain('"x":7');
    expect(JSON.stringify(await seen(f.accountB))).not.toContain('"x":7');
  });

  it('shows no active token to a seat that cannot see the hidden entity acting', async () => {
    const { f, entA, entB, seen } = await twoSeatCombat();
    const state = f.room.state.gameState as {
      characters: Record<string, { id: string }>;
      combatRoom: { combat: { activeEntityId: string } };
    };
    state.characters[f.seatA]!.id = 'rogue';
    state.combatRoom.combat.activeEntityId = 'rogue';
    const tracker = async (account: string) =>
      (await seen(account)).find((m) => m.type === 'CombatTracker')!
        .payload as {
        activeEntityId: string | null;
        initiative: { entityId: string }[];
      };
    const other = await tracker(f.accountB);
    expect(other.activeEntityId).toBeNull();
    // order continues after the hidden actor, hidden entity omitted
    expect(other.initiative.map((i) => i.entityId)).toEqual([
      entB,
      'goblin',
      entA,
    ]);
    expect((await tracker(f.accountA)).activeEntityId).toBe('rogue');
  });

  it('keeps the list head as active when no entity is hidden and none is recorded (solo/null state)', async () => {
    const { f, seen } = await twoSeatCombat();
    const state = f.room.state.gameState as {
      combatRoom: {
        entities: { hidden?: boolean }[];
        combat: { activeEntityId: string | null };
      };
    };
    for (const e of state.combatRoom.entities) delete e.hidden;
    state.combatRoom.combat.activeEntityId = null;
    const messages = await seen(f.accountB);
    const sync = messages.find((m) => m.type === 'StateSync')!;
    const gs = (
      sync.payload as {
        state: {
          gameState: Record<string, { combat: { activeEntityId: string } }>;
        };
      }
    ).state.gameState;
    expect(gs.combatRoom.combat.activeEntityId).toBe(seatEntityId(f.seatA));
    const tracker = messages.find((m) => m.type === 'CombatTracker')!
      .payload as { activeEntityId: string };
    expect(tracker.activeEntityId).toBe(seatEntityId(f.seatA));
  });

  it('filters streamed rolls naming hidden actors or targets from non-controllers', async () => {
    let entA = '';
    const f = party({
      bindB: true,
      turnRunner: {
        async run(_request, onEvent) {
          onEvent({
            type: 'RollEvent',
            kind: 'attack',
            entityId: 'rogue',
            targetId: entA,
            attackId: 'hidden-actor-attack',
            hit: true,
          });
          onEvent({
            type: 'RollEvent',
            kind: 'damage',
            entityId: entA,
            targetId: 'hidden-target',
            attackId: 'hidden-target-attack',
            publicDamage: 4,
          });
          return {
            events: [],
            narration: '',
            state: {},
            fallback: 'endpoint-error',
            endpointRetryable: true,
          } as never;
        },
      } as unknown as SoloTurnRunner,
    });
    entA = seatEntityId(f.seatA);
    const entB = seatEntityId(f.seatB);
    const game = {
      characters: {
        [f.seatA]: { id: 'rogue' },
        [f.seatB]: { id: 'hidden-target' },
      },
      combatRoom: {
        entities: [
          {
            id: 'rogue',
            hidden: true,
            kind: 'monster',
            team: 'foe',
            hp: 8,
            maxHp: 8,
          },
          { id: entA, kind: 'character', team: 'party', hp: 8, maxHp: 8 },
          { id: entB, kind: 'character', team: 'party', hp: 8, maxHp: 8 },
          {
            id: 'hidden-target',
            hidden: true,
            kind: 'monster',
            team: 'foe',
            hp: 8,
            maxHp: 8,
          },
        ],
        combat: {
          round: 1,
          activeEntityId: entA,
          initiative: [],
          resources: {},
        },
      },
    };
    f.room.state.gameState = game;
    const inbox = {
      [f.accountA]: [] as Record<string, unknown>[],
      [f.accountB]: [] as Record<string, unknown>[],
    };
    for (const account of [f.accountA, f.accountB])
      await f.room.subscribe(account, {
        send: (message: Record<string, unknown>) =>
          void inbox[account]!.push(message),
      });
    for (const messages of Object.values(inbox)) messages.length = 0;

    await expect(
      (
        f.room as unknown as { resolveTurn(...args: unknown[]): Promise<void> }
      ).resolveTurn(f.accountA, randomUUID(), 'roll', 'A', false),
    ).rejects.toThrow();

    const rolls = (account: string) =>
      inbox[account]!.filter((message) => message.type === 'RollEvent').map(
        (message) => message.payload,
      );
    expect(rolls(f.accountA)).toHaveLength(1);
    expect(JSON.stringify(rolls(f.accountA))).toContain('hidden-actor-attack');
    expect(JSON.stringify(rolls(f.accountA))).not.toContain('hidden-target');
    expect(rolls(f.accountB)).toHaveLength(1);
    expect(JSON.stringify(rolls(f.accountB))).toContain('hidden-target-attack');
    expect(JSON.stringify(rolls(f.accountB))).not.toContain('rogue');
    expect(JSON.stringify(rolls(f.accountB))).not.toContain(entB);
  });

  it("hides a PC's roll modifier, weapon and spell name from other seats, not from its controller", async () => {
    const { f, entA } = await twoSeatCombat();
    const state = f.room.state.gameState as { combatRoom: unknown };
    const roll = (
      extra: Record<string, unknown>,
      expression: string,
      bonus: number,
    ) => ({
      type: 'RollEvent',
      entityId: entA,
      breakdown: {
        expression,
        dice: [{ value: 14, kept: true }],
        modifiers: [{ label: 'bonus', value: bonus }],
        total: 14 + bonus,
      },
      ...extra,
    });
    const inbox = {
      [f.accountA]: [] as Record<string, unknown>[],
      [f.accountB]: [] as Record<string, unknown>[],
    };
    for (const account of [f.accountA, f.accountB])
      await f.room.subscribe(account, {
        send: (m: Record<string, unknown>) => void inbox[account]!.push(m),
      });
    for (const list of Object.values(inbox)) list.length = 0;
    (
      f.room as unknown as { announceCombat(...a: unknown[]): void }
    ).announceCombat(
      state.combatRoom,
      [
        roll(
          {
            kind: 'attack',
            attackId: 'rapier',
            targetId: seatEntityId(f.seatB),
            hit: true,
          },
          '1d20+5',
          5,
        ),
        roll(
          { kind: 'save', spellId: 'fireball', dc: 13, success: true },
          '1d20+3',
          3,
        ),
        roll(
          {
            kind: 'damage',
            attackId: 'rapier',
            targetId: seatEntityId(f.seatB),
            publicDamage: 6,
          },
          '1d8+3',
          3,
        ),
      ],
      undefined,
    );
    const wire = (account: string) =>
      JSON.stringify(inbox[account]!.filter((m) => m.type === 'CombatEvents'));
    const mine = wire(f.accountA);
    for (const secret of ['+5', '+3', 'rapier', 'fireball', '"modifier":5'])
      expect(mine).toContain(secret);
    const other = wire(f.accountB);
    for (const secret of ['+5', '+3', 'rapier', 'fireball', 'modifier'])
      expect(other).not.toContain(secret);
    expect(other).toContain('"hit":true');
    expect(other).toContain('"targetId":"' + seatEntityId(f.seatB) + '"');
    const otherEvents = (
      JSON.parse(other)[0]!.payload as { events: Record<string, unknown>[] }
    ).events;
    expect(otherEvents[0]).not.toHaveProperty('total');
    expect(otherEvents[0]).not.toHaveProperty('rolls');
    expect(otherEvents[0]).not.toHaveProperty('modifier');
    expect(otherEvents[2]).toMatchObject({
      damage: 6,
      targetId: seatEntityId(f.seatB),
    });
    expect(otherEvents[2]).not.toHaveProperty('total');
    expect(otherEvents[2]).not.toHaveProperty('rolls');
    expect(otherEvents[2]).not.toHaveProperty('modifier');
  });

  it('redacts damage-roll totals against monsters from both combat viewers', async () => {
    const { f, entA } = await twoSeatCombat();
    const state = f.room.state.gameState as { combatRoom: unknown };
    const inbox = {
      [f.accountA]: [] as Record<string, unknown>[],
      [f.accountB]: [] as Record<string, unknown>[],
    };
    for (const account of [f.accountA, f.accountB])
      await f.room.subscribe(account, {
        send: (message: Record<string, unknown>) =>
          void inbox[account]!.push(message),
      });
    for (const messages of Object.values(inbox)) messages.length = 0;

    const combat = state.combatRoom as {
      entities: { id: string; hp: number }[];
    };
    combat.entities.find((entity) => entity.id === 'goblin')!.hp = 3;
    (
      f.room as unknown as { announceCombat(...args: unknown[]): void }
    ).announceCombat(
      state.combatRoom,
      [
        {
          type: 'RollEvent',
          entityId: entA,
          kind: 'damage',
          attackId: 'greatsword',
          targetId: 'goblin',
          breakdown: {
            expression: '1d4',
            dice: [{ sides: 4, value: 4, kept: true }],
            modifiers: [],
            total: 4,
          },
          publicDamage: 4,
        },
        { type: 'HpChanged', entityId: 'goblin', from: 7, to: 3, damage: 4 },
      ],
      f.accountA,
    );

    for (const account of [f.accountA, f.accountB]) {
      const messages = inbox[account]!.filter(
        (message) => message.type === 'CombatEvents',
      );
      const event = (
        messages[0]!.payload as { events: Record<string, unknown>[] }
      ).events[0]!;
      expect(event).toMatchObject({ actorId: entA, targetId: 'goblin' });
      if (account === f.accountB) {
        expect(event).not.toHaveProperty('damage');
        expect(event).not.toHaveProperty('total');
        expect(event).not.toHaveProperty('rolls');
        expect(event).not.toHaveProperty('modifier');
        const events = (
          messages[0]!.payload as { events: Record<string, unknown>[] }
        ).events;
        expect(events.find((item) => item.type === 'HpChanged')).toEqual({
          type: 'HpChanged',
          entityId: 'goblin',
          hpState: 'wounded',
        });
      }
    }
  });

  it('strips engine-only seed and engineReactions from every viewer, keeping them server-side', async () => {
    const { f, seen } = await twoSeatCombat();
    for (const account of [f.accountA, f.accountB]) {
      const wire = JSON.stringify(await seen(account));
      expect(wire).not.toContain('424242');
      expect(wire).not.toContain('engine-continuation');
    }
    expect(JSON.stringify(f.room.state.gameState)).toContain('424242');
  });

  it('delivers committed events naming a hidden entity only to its controller', async () => {
    const { f, entB } = await twoSeatCombat();
    const state = f.room.state.gameState as {
      characters: Record<string, { id: string }>;
      combatRoom: { entities: { id: string; hidden?: boolean }[] };
    };
    // seat A controls the hidden rogue; seat B does not
    state.characters[f.seatA]!.id = 'rogue';
    const inbox = {
      [f.accountA]: [] as Record<string, unknown>[],
      [f.accountB]: [] as Record<string, unknown>[],
    };
    for (const account of [f.accountA, f.accountB])
      await f.room.subscribe(account, {
        send: (m: Record<string, unknown>) => void inbox[account]!.push(m),
      });
    for (const list of Object.values(inbox)) list.length = 0;
    const events = [
      {
        type: 'EntityMoved',
        entityId: 'rogue',
        path: [{ x: 7, y: 8 }, HIDDEN_POS],
      },
      { type: 'HpChanged', entityId: 'rogue', hp: 3 },
      { type: 'ConditionApplied', entityId: 'rogue', conditionId: 'prone' },
      {
        type: 'OpportunityTriggered',
        moverId: entB,
        attackerId: 'rogue',
      },
      { type: 'EntityMoved', entityId: 'goblin', path: [{ x: 4, y: 5 }] },
    ];
    (
      f.room as unknown as { announceCombat(...a: unknown[]): void }
    ).announceCombat(state.combatRoom, events, undefined);
    const eventsSeenBy = (account: string) =>
      inbox[account]!.filter((m) => m.type === 'CombatEvents').flatMap(
        (m) => (m.payload as { events: Record<string, unknown>[] }).events,
      );
    const trackerSeenBy = (account: string) =>
      JSON.stringify(inbox[account]!.filter((m) => m.type === 'CombatTracker'));
    expect(trackerSeenBy(f.accountA)).toContain('"x":7');
    expect(trackerSeenBy(f.accountB)).not.toContain('"x":7');
    const promptsSeenBy = (account: string) =>
      inbox[account]!.filter((m) => m.type === 'ReactionPrompt');
    expect(promptsSeenBy(f.accountA)).toHaveLength(1);
    expect(promptsSeenBy(f.accountB)).toHaveLength(0);
    expect(eventsSeenBy(f.accountA)).toHaveLength(5);
    const other = eventsSeenBy(f.accountB);
    expect(other).toEqual([events[4]]);
    expect(JSON.stringify(other)).not.toContain('rogue');
    expect(JSON.stringify(other)).not.toContain('"x":7');
  });

  it('redacts monster HP numbers from queued narration facts while retaining party HP', async () => {
    const { f, entA } = await twoSeatCombat();
    const roomInternals = f.room as unknown as {
      turnInFlight: boolean;
      queueNarration(
        events: Record<string, unknown>[],
        accountId: string,
        turnId: string,
        characterIds: Set<string>,
      ): void;
      queuedActions: { combatFacts: Record<string, unknown>[] }[];
    };
    roomInternals.turnInFlight = true;
    roomInternals.queueNarration(
      [
        { type: 'HpChanged', entityId: 'goblin', from: 7, to: 3, damage: 4 },
        { type: 'HpChanged', entityId: entA, from: 5, to: 3, damage: 2 },
      ],
      f.accountA,
      'turn',
      new Set([entA]),
    );
    const facts = roomInternals.queuedActions[0]!.combatFacts;
    expect(facts[0]).toEqual({
      type: 'HpChanged',
      entityId: 'goblin',
      hpState: 'wounded',
      tier: 'must',
    });
    expect(JSON.stringify(facts[0])).not.toMatch(/[0-9]/);
    expect(facts[1]).toEqual({
      type: 'HpChanged',
      entityId: entA,
      from: 5,
      to: 3,
      damage: 2,
      tier: 'must',
    });
  });

  it('projects monster HP events per viewer but preserves public party HP events', async () => {
    const { f, entA } = await twoSeatCombat();
    const state = f.room.state.gameState as {
      combatRoom: { entities: { id: string }[] };
    };
    const inbox: Record<string, Record<string, unknown>[]> = {
      [f.accountA]: [],
      [f.accountB]: [],
    };
    for (const account of [f.accountA, f.accountB])
      await f.room.subscribe(account, {
        send: (m: Record<string, unknown>) => void inbox[account]!.push(m),
      });
    for (const messages of Object.values(inbox)) messages.length = 0;
    const events = [
      { type: 'HpChanged', entityId: 'goblin', from: 4, to: 0, damage: 4 },
      { type: 'HpChanged', entityId: entA, from: 5, to: 3, damage: 2 },
    ];
    (
      f.room as unknown as { announceCombat(...a: unknown[]): void }
    ).announceCombat(state.combatRoom, events, undefined);
    const received = (account: string) =>
      inbox[account]!.filter((m) => m.type === 'CombatEvents').flatMap(
        (m) => (m.payload as { events: Record<string, unknown>[] }).events,
      );
    for (const account of [f.accountA, f.accountB])
      expect(received(account)).toEqual([
        { type: 'HpChanged', entityId: 'goblin', hpState: 'down' },
        events[1],
      ]);
  });
});
