import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  bootstrapped,
  account,
  memoryTable,
  placed,
} from './combatFixtures.js';
import { joinSeated } from '../helpers/room.js';
import type { RoomCombatState } from '../../src/room/combat.js';

afterEach(() => vi.useRealTimers());
type Msg = import('@game/schema').ServerMessage;

const evs = (messages: Msg[]) =>
  messages
    .filter((m) => m.type === 'CombatEvents')
    .flatMap(
      (m) => (m.payload as { events: Record<string, unknown>[] }).events,
    );

function scenario(
  goblinAt: { x: number; y: number },
  hidden: boolean,
  controlled: boolean,
) {
  const b = bootstrapped();
  const state = placed(b.state, {
    ent_aria: { x: 7, y: 2 },
    'ent_goblin-minion_1': goblinAt,
    'ent_goblin-minion_2': { x: 12, y: 16 },
  });
  const reactor = crypto.randomUUID();
  const watcherId = crypto.randomUUID();
  const combat: RoomCombatState = {
    ...state,
    promptEvents: true,
    entities: state.entities.map((e) =>
      e.id === 'ent_goblin-minion_1' && hidden ? { ...e, hidden: true } : e,
    ),
  };
  const table = memoryTable({
    ...b.game,
    combatActors: {
      [account]: 'ent_aria',
      ...(controlled ? { [reactor]: 'ent_goblin-minion_1' } : {}),
    },
    combatRoom: combat,
  });
  return { table, reactor, watcherId };
}

async function run(
  goblinAt: { x: number; y: number },
  hidden: boolean,
  controlled: boolean,
) {
  vi.useFakeTimers();
  const { table, reactor, watcherId } = scenario(goblinAt, hidden, controlled);
  const room = table.boot();
  await joinSeated(room, account, table.connection);
  if (controlled) await joinSeated(room, reactor, { send: () => {} });
  const watcher: Msg[] = [];
  await joinSeated(room, watcherId, { send: (m: Msg) => void watcher.push(m) });
  watcher.length = 0;
  await room.submitCombatCommand(account, crypto.randomUUID(), {
    command: 'move',
    destination: { x: 7, y: 6 },
  });
  await vi.advanceTimersByTimeAsync(0);
  await room.drain();
  const seen = evs(watcher).map((e) => e.type);
  const moved = evs(watcher).filter((e) => e.type === 'EntityMoved');
  const durable = table.events.map((e) => e.type);
  const declined = table.events
    .filter((e) => e.type === 'ReactionDeclined')
    .map((e) => e.payload);
  const revealedToWatcher = evs(watcher).filter(
    (e) => e.type === 'EntityRevealed',
  );
  return {
    seen,
    movedCount: moved.length,
    movedCost: moved.map((m) => m.cost),
    movedPath: moved.map((m) => m.path),
    movementSpent: evs(watcher).filter((e) => e.type === 'MovementSpent'),
    durable,
    declined,
    revealedToWatcher,
  };
}

describe('hidden movement projection for non-controlling watchers', () => {
  it('far goblin baseline emits one complete route and no movement spend', async () => {
    const r = await run({ x: 12, y: 16 }, false, false);
    expect(r.movedCount).toBe(1);
    expect(r.movementSpent).toEqual([]);
  });
  it('hidden uncontrolled reactor (no-controller) matches the baseline route', async () => {
    const r = await run({ x: 8, y: 2 }, true, false);
    const baseline = await run({ x: 12, y: 16 }, false, false);
    expect(r.seen).toEqual(baseline.seen);
    expect(r.movedPath).toEqual(baseline.movedPath);
    expect(r.movedCost).toEqual(baseline.movedCost);
    expect(r.movedCount).toBe(1);
    expect(r.movementSpent).toEqual([]);
    expect(r.durable.filter((type) => type === 'MovementSpent')).toHaveLength(
      4,
    );
  });
  it('hidden controlled reactor (auto) matches the baseline route', async () => {
    const r = await run({ x: 8, y: 2 }, true, true);
    const baseline = await run({ x: 12, y: 16 }, false, false);
    expect(r.seen).toEqual(baseline.seen);
    expect(r.movedPath).toEqual(baseline.movedPath);
    expect(r.movedCost).toEqual(baseline.movedCost);
    expect(r.movedCount).toBe(1);
    expect(r.movementSpent).toEqual([]);
    expect(r.durable.filter((type) => type === 'MovementSpent')).toHaveLength(
      4,
    );
  });
  it('same-team hidden ally bump reveals the ally and preserves each walked step', async () => {
    vi.useFakeTimers();
    const b = bootstrapped();
    const state = placed(b.state, {
      ent_aria: { x: 7, y: 2 },
      'ent_goblin-minion_1': { x: 12, y: 16 },
      'ent_goblin-minion_2': { x: 7, y: 6 },
    });
    const aria = state.entities.find((e) => e.id === 'ent_aria')!;
    const combat: RoomCombatState = {
      ...state,
      promptEvents: true,
      entities: state.entities.map((e) =>
        e.id === 'ent_goblin-minion_2'
          ? {
              ...e,
              hidden: true,
              team: aria.team,
            }
          : e,
      ),
    };
    const table = memoryTable({
      ...b.game,
      combatActors: { [account]: 'ent_aria' },
      combatRoom: combat,
    });
    const room = table.boot();
    await joinSeated(room, account, table.connection);
    const watcher: Msg[] = [];
    await joinSeated(room, crypto.randomUUID(), {
      send: (m: Msg) => void watcher.push(m),
    });
    watcher.length = 0;
    await room.submitCombatCommand(account, crypto.randomUUID(), {
      command: 'move',
      destination: { x: 7, y: 6 },
    });
    await vi.advanceTimersByTimeAsync(0);
    await room.drain();
    const moved = evs(watcher).filter((e) => e.type === 'EntityMoved');
    expect(moved.map((event) => event.path)).toEqual([
      [{ x: 6, y: 3 }],
      [{ x: 6, y: 4 }],
      [{ x: 6, y: 5 }],
    ]);
    expect(
      evs(watcher).find((event) => event.type === 'EntityRevealed'),
    ).toMatchObject({
      entityId: 'ent_goblin-minion_2',
      cause: 'bump',
    });
    expect(
      evs(watcher).filter((event) => event.type === 'MovementSpent'),
    ).toHaveLength(3);
  });
  it('visible uncontrolled reactor retains per-step movement events', async () => {
    const r = await run({ x: 8, y: 2 }, false, false);
    expect(r.movedCount).toBe(4);
    expect(r.movementSpent).toHaveLength(4);
  });
});
