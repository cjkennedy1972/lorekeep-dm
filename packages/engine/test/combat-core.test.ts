import { describe, expect, test } from 'vitest';
import {
  apply,
  emptyCombatState,
  replay,
  type CombatEvent,
  type CombatState,
} from '../src/combat/state.js';
import {
  endTurn,
  rollInitiative,
  spendAction,
  spendMovement,
  startCombat,
  startTurn,
} from '../src/combat/commands.js';

const participants = [
  { id: 'a', initiativeModifier: 2, speed: 30 },
  { id: 'b', initiativeModifier: 1, speed: 25 },
  { id: 'c', initiativeModifier: 2, speed: 35 },
];
function begun(seed: number): { state: CombatState; events: CombatEvent[] } {
  const start = emptyCombatState();
  const started = startCombat(start, participants);
  if (!started.ok) throw new Error(started.error);
  const rolled = rollInitiative(replay(start, started.events), seed);
  if (!rolled.ok) throw new Error(rolled.error);
  const events = [...started.events, ...rolled.events];
  return { state: replay(start, events), events };
}

describe('combat state and commands', () => {
  test('initiative is deterministic and ties sort by higher Dex then participant order', () => {
    const first = begun(1234);
    expect(first.state.initiative).toEqual(begun(1234).state.initiative);
    const started = apply(emptyCombatState(), {
      type: 'CombatStarted',
      combatants: participants,
    });
    const a = apply(started, {
      type: 'InitiativeRolled',
      entityId: 'a',
      total: 14,
    });
    const c = apply(a, { type: 'InitiativeRolled', entityId: 'c', total: 14 });
    const tied = apply(c, {
      type: 'InitiativeRolled',
      entityId: 'b',
      total: 14,
    });
    expect(tied.initiative.map((x) => x.entityId)).toEqual(['a', 'c', 'b']);
  });

  test('action cannot be spent twice in one turn and returns a helpful hint', () => {
    const { state } = begun(42);
    const started = startTurn(state, state.initiative[0]!.entityId);
    if (!started.ok) throw new Error(started.error);
    const active = replay(state, started.events);
    const spent = spendAction(active);
    if (!spent.ok) throw new Error(spent.error);
    const again = spendAction(replay(active, spent.events));
    expect(again).toMatchObject({
      error: expect.stringMatching(/already spent/i),
      hint: expect.stringMatching(/next turn/i),
    });
  });

  test('movement resets at turn start and decrements only through events', () => {
    const { state } = begun(42);
    const first = startTurn(state, state.initiative[0]!.entityId);
    if (!first.ok) throw new Error(first.error);
    const active = replay(state, first.events);
    const mover = active.activeEntityId!;
    expect(active.resources[mover]!.movementRemaining).toBe(
      participants.find((x) => x.id === mover)!.speed,
    );
    const movement = spendMovement(active, 10);
    if (!movement.ok) throw new Error(movement.error);
    expect(movement.events).toEqual([
      { type: 'MovementSpent', entityId: mover, feet: 10 },
    ]);
    const moved = replay(active, movement.events);
    expect(moved.resources[mover]!.movementRemaining).toBe(
      participants.find((x) => x.id === mover)!.speed - 10,
    );
    const ended = endTurn(moved);
    if (!ended.ok) throw new Error(ended.error);
    const endedState = replay(moved, ended.events);
    const nextId =
      endedState.initiative[
        (endedState.turnIndex + 1) % endedState.initiative.length
      ]!.entityId;
    const next = startTurn(endedState, nextId);
    if (!next.ok) throw new Error(next.error);
    expect(
      replay(endedState, next.events).resources[nextId]!.movementRemaining,
    ).toBe(participants.find((x) => x.id === nextId)!.speed);
  });

  test('event replay reproduces command results across deterministic seeds', () => {
    for (let seed = 0; seed < 64; seed++) {
      const start = emptyCombatState();
      const started = startCombat(start, participants);
      if (!started.ok) throw new Error(started.error);
      const combat = replay(start, started.events);
      const rolled = rollInitiative(combat, seed);
      if (!rolled.ok) throw new Error(rolled.error);
      const afterInitiative = replay(combat, rolled.events);
      const turn = startTurn(
        afterInitiative,
        afterInitiative.initiative[0]!.entityId,
      );
      if (!turn.ok) throw new Error(turn.error);
      const active = replay(afterInitiative, turn.events);
      const action = spendAction(active);
      if (!action.ok) throw new Error(action.error);
      const afterAction = replay(active, action.events);
      const movement = spendMovement(afterAction, 5);
      if (!movement.ok) throw new Error(movement.error);
      const allEvents = [
        ...started.events,
        ...rolled.events,
        ...turn.events,
        ...action.events,
        ...movement.events,
      ];
      expect(replay(start, allEvents)).toEqual(
        replay(afterAction, movement.events),
      );
    }
  });
});
