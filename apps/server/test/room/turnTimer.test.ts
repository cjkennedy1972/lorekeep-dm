import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RoomCombatState } from '../../src/room/combat.js';
import {
  account,
  bootstrapped,
  memoryTable,
  placed,
} from './combatFixtures.js';
import { joinSeated } from '../helpers/room.js';

afterEach(() => vi.useRealTimers());

const stage = (opts: Parameters<typeof memoryTable>[2] = {}) => {
  const e = bootstrapped();
  return memoryTable(
    { ...e.game, combatActors: { [account]: 'ent_aria' }, combatRoom: e.state },
    undefined,
    { host: account, ...opts },
  );
};

describe('host turn timer setting (ADR-033 §5.1)', () => {
  it('persists, and a restarted Room replays it', async () => {
    const table = stage();
    const room = table.boot();
    await joinSeated(room, account, table.connection);
    await room.configureTurnTimer(account, 45_000, 'hold');
    expect(room.state.turnTimerMs).toBe(45_000);
    expect(table.events.map((e) => e.type)).toContain('TurnTimerConfigured');
    const again = table.boot();
    expect(again.state.turnTimerMs).toBe(45_000);
    expect(again.state.turnTimeoutAction).toBe('hold');
    await again.configureTurnTimer(account, null);
    expect(table.boot().state.turnTimerMs).toBeNull();
    // Omitting the action leaves the earlier choice in place.
    expect(table.boot().state.turnTimeoutAction).toBe('hold');
  });

  it.each([29_999, 600_001, 45_000.5])('rejects %s ms', async (ms) => {
    const table = stage();
    const room = table.boot();
    await joinSeated(room, account, table.connection);
    await expect(room.configureTurnTimer(account, ms)).rejects.toThrow(
      /between 30 and 600/,
    );
    expect(room.state.turnTimerMs).toBeUndefined();
  });

  it('is host-only', async () => {
    const table = stage({ host: crypto.randomUUID() });
    const room = table.boot();
    await joinSeated(room, account, table.connection);
    await expect(room.configureTurnTimer(account, 60_000)).rejects.toThrow(
      /host/,
    );
  });
});

const START = 2_000_000;

/** A party-first combat whose Aria turn is open with a running timer; a stub DM counts narrations. */
function openTurn(
  opts: Parameters<typeof memoryTable>[2] = {},
  combatPatch: Partial<RoomCombatState> = {},
) {
  vi.useFakeTimers();
  vi.setSystemTime(START);
  const e = bootstrapped();
  const narrations: string[] = [];
  const runner = {
    async run(request: unknown) {
      narrations.push(String((request as { text?: unknown }).text));
      return {
        narration: 'The turn resolves.',
        events: [],
        state: (request as { state?: unknown }).state ?? {},
        usage: { in: 1, out: 1 },
      } as never;
    },
  };
  const combat: RoomCombatState = {
    ...e.state,
    phase: 'awaiting-command',
    turnId: 'turn-1',
    narrationAttempts: 0,
    turnDeadline: START + 90_000,
    combat: { ...e.state.combat, activeEntityId: 'ent_aria' },
    ...combatPatch,
  };
  const table = memoryTable(
    { ...e.game, combatActors: { [account]: 'ent_aria' }, combatRoom: combat },
    runner,
    { host: account, state: { turnTimerMs: 90_000 }, ...opts },
  );
  const of = (type: string) => table.events.filter((ev) => ev.type === type);
  return { table, narrations, of };
}

describe('turn timer expiry (ADR-033 §5.3-5.4)', () => {
  it('fires at the deadline, not before: TurnTimedOut, Dodge, one resolution, one narration, next turn opens', async () => {
    const { table, narrations, of } = openTurn();
    const room = table.boot();
    await joinSeated(room, account, table.connection);
    await vi.advanceTimersByTimeAsync(89_999);
    expect(of('TurnTimedOut')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await room.drain();
    expect(of('TurnTimedOut')).toHaveLength(1);
    expect(of('TurnTimedOut')[0]!.payload).toMatchObject({
      turnId: 'turn-1',
      entityId: 'ent_aria',
      action: 'dodge',
    });
    expect(of('DodgeDeclared')[0]!.payload).toMatchObject({
      source: 'timeout',
    });
    expect(of('AutopilotActed')).toHaveLength(0);
    expect(of('TurnResolved')).toHaveLength(1);
    expect(narrations).toHaveLength(1);
    expect(of('NarrationCommitted')).toHaveLength(1);
    const opened = of('TurnOpened');
    expect(opened).toHaveLength(1);
    expect((opened[0]!.payload as { turnId: string }).turnId).not.toBe(
      'turn-1',
    );
  });

  it('applies hold when the table configured it', async () => {
    const { table, of } = openTurn({
      state: { turnTimerMs: 90_000, turnTimeoutAction: 'hold' },
    });
    const room = table.boot();
    await joinSeated(room, account, table.connection);
    await vi.advanceTimersByTimeAsync(90_000);
    await room.drain();
    expect(of('TurnTimedOut')[0]!.payload).toMatchObject({ action: 'hold' });
    expect(of('DodgeDeclared')).toHaveLength(0);
    expect(of('TurnResolved')).toHaveLength(1);
  });

  it('falls back to hold when Dodge is rejected (action already spent)', async () => {
    const e = bootstrapped();
    const { table, of } = openTurn(
      {},
      {
        combat: {
          ...e.state.combat,
          activeEntityId: 'ent_aria',
          resources: {
            ...e.state.combat.resources,
            ent_aria: {
              ...e.state.combat.resources.ent_aria!,
              action: false,
            },
          },
        },
      },
    );
    const room = table.boot();
    await joinSeated(room, account, table.connection);
    await vi.advanceTimersByTimeAsync(90_000);
    await room.drain();
    expect(of('TurnTimedOut')[0]!.payload).toMatchObject({ action: 'hold' });
    expect(of('TurnResolved')).toHaveLength(1);
  });

  it('a solo table with no setting has no timer and no deadline on the next turn', async () => {
    const { table, of } = openTurn({ state: {} }, { turnDeadline: undefined });
    const room = table.boot();
    await joinSeated(room, account, table.connection);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(of('TurnTimedOut')).toHaveLength(0);
    await room.submitCombatCommand(account, crypto.randomUUID(), {
      command: 'end-turn',
    });
    await vi.advanceTimersByTimeAsync(1);
    await room.drain();
    expect(of('TurnOpened')[0]!.payload).toMatchObject({ deadline: null });
  });

  it('the next turn gets a fresh absolute deadline from the configured length', async () => {
    const { table, of } = openTurn({ state: { turnTimerMs: 45_000 } });
    const room = table.boot();
    await joinSeated(room, account, table.connection);
    await vi.advanceTimersByTimeAsync(90_000);
    await room.drain();
    const opened = of('TurnOpened')[0]!.payload as { deadline: number };
    expect(opened.deadline).toBeGreaterThanOrEqual(START + 45_000);
    expect(opened.deadline).toBeLessThanOrEqual(START + 90_000 + 45_000);
  });
});

describe('one resolution per turn: player command vs timer', () => {
  const endTurn = (room: ReturnType<ReturnType<typeof memoryTable>['boot']>) =>
    room.submitCombatCommand(account, crypto.randomUUID(), {
      command: 'end-turn',
    });

  it('a command that lands first wins; the timer then does nothing', async () => {
    const { table, of } = openTurn();
    const room = table.boot();
    await joinSeated(room, account, table.connection);
    await vi.advanceTimersByTimeAsync(89_999);
    await endTurn(room);
    await vi.advanceTimersByTimeAsync(5_000);
    await room.drain();
    expect(of('TurnTimedOut')).toHaveLength(0);
    expect(of('TurnResolved')).toHaveLength(1);
  });

  it('an expiry that lands first wins; the late command is rejected', async () => {
    const { table, of } = openTurn();
    const room = table.boot();
    await joinSeated(room, account, table.connection);
    vi.advanceTimersByTime(90_000); // timer callback queued in the mailbox
    await endTurn(room);
    await vi.advanceTimersByTimeAsync(1);
    await room.drain();
    expect(of('TurnTimedOut')).toHaveLength(1);
    expect(of('TurnResolved')).toHaveLength(1);
    expect(table.messages.some((m) => m.type === 'Error')).toBe(true);
  });

  it('a command queued ahead of the expiry in the same tick wins', async () => {
    const { table, of } = openTurn();
    const room = table.boot();
    await joinSeated(room, account, table.connection);
    vi.setSystemTime(START + 90_000);
    const pending = endTurn(room);
    vi.advanceTimersByTime(0);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    await room.drain();
    expect(of('TurnTimedOut')).toHaveLength(0);
    expect(of('TurnResolved')).toHaveLength(1);
  });
});

describe('turn timer freezes during a reaction window (ADR-033 §5.2)', () => {
  it('stores the remaining time while the prompt is open and rebuilds the deadline after', async () => {
    const e = bootstrapped();
    const { table, of } = openTurn(
      {},
      {
        entities: placed(e.state, {
          ent_aria: { x: 7, y: 2 },
          'ent_goblin-minion_1': { x: 8, y: 2 },
          'ent_goblin-minion_2': { x: 12, y: 16 },
        }).entities,
      },
    );
    const room = table.boot();
    await joinSeated(room, account, table.connection);
    await vi.advanceTimersByTimeAsync(30_000);
    await room.submitCombatCommand(account, crypto.randomUUID(), {
      command: 'move',
      destination: { x: 7, y: 6 },
    });
    const frozen = table.game().combatRoom as RoomCombatState;
    expect(frozen.pendingReaction).toBeDefined();
    expect(frozen.turnDeadline).toBeUndefined();
    expect(frozen.turnTimerRemainingMs).toBe(60_000);
    // The original deadline passes while the prompt is open and the 15 s window declines it.
    await vi.advanceTimersByTimeAsync(15_000);
    const thawed = table.game().combatRoom as RoomCombatState;
    expect(thawed.pendingReaction).toBeUndefined();
    expect(thawed.turnTimerRemainingMs).toBeUndefined();
    expect(thawed.turnDeadline).toBe(START + 45_000 + 60_000);
    await vi.advanceTimersByTimeAsync(44_999); // T0+90 s: the old deadline
    expect(of('TurnTimedOut')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(15_001);
    await room.drain();
    expect(of('TurnTimedOut')).toHaveLength(1);
  });
});
