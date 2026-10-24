import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  Room,
  RoomSeatRequiredError,
  type Connection,
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
      return { events: out };
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
          seats: [seat(seatA, accountA), seat(seatB, accountB)],
          gameState: options.gameState?.(seatA) ?? {},
        },
      },
      events: [],
    },
    runner,
    options.runtime,
    bindings,
    options.partyMode ?? true,
  );
  return { room, writes, accountA, accountB, seatA, seatB };
}

describe('ADR-035 party seat gating', () => {
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

  it('does not emit a release for a seat that was never bound', async () => {
    const { room, writes, accountB } = party();
    await room.leave(accountB);
    expect(writes.at(-1)?.events).toEqual(['SeatRevoked']);
    expect(writes.at(-1)?.transition).toBeUndefined();
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
