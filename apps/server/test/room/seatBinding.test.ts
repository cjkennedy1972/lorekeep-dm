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
    runtime?: CombatRuntime;
    hostA?: boolean;
    roundsEnabled?: boolean;
    turnRunner?: SoloTurnRunner;
    failBindingReload?: boolean;
  } = {},
) {
  const [accountA, accountB, seatA, seatB] = [1, 2, 3, 4].map(() =>
    randomUUID(),
  );
  const writes: { events: string[]; transition: unknown }[] = [];
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
    ) {
      writes.push({ events: inputs.map((i) => i.type), transition });
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
      return {
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
      };
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
      hp: privateSheet.hp,
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
