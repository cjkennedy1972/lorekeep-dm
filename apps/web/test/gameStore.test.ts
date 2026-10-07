import { describe, expect, it } from 'vitest';
import {
  emptyCombatState,
  endTurn,
  replay,
  rollInitiative,
  spendAction,
  spendMovement,
  startCombat,
  startTurn,
  type CombatEvent,
  type CombatState,
} from '@game/rules-engine';
import { createGameStore } from '../src/state/gameStore';
import { selectActiveCombatant, selectTracker } from '../src/state/selectors';

// Locally generated event log. TODO(M1-29): replace with the golden event log fixture once it exists.
function generateLog(): CombatEvent[] {
  let s: CombatState = emptyCombatState();
  const log: CombatEvent[] = [];
  const run = (r: ReturnType<typeof startCombat>) => {
    if (!('ok' in r)) throw new Error(r.error);
    for (const e of r.events) {
      s = replay(s, [e]);
      log.push(e);
    }
  };
  run(
    startCombat(s, [
      { id: 'a', initiativeModifier: 2, speed: 30 },
      { id: 'b', initiativeModifier: 0, speed: 30 },
      { id: 'c', initiativeModifier: 1, speed: 40 },
    ]),
  );
  run(rollInitiative(s, 12345));
  run(startTurn(s, s.initiative[0]!.entityId));
  run(spendAction(s));
  run(spendMovement(s, 10));
  run(endTurn(s));
  run(startTurn(s, s.initiative[1]!.entityId));
  return log;
}

describe('gameStore', () => {
  it('applying the event log yields the same final state as the engine', () => {
    const log = generateLog();
    const store = createGameStore();
    log.forEach((e) => store.applyEvent(e));
    expect(store.getState().combat).toEqual(replay(emptyCombatState(), log));
  });

  it('notifies subscribers', () => {
    const store = createGameStore();
    let n = 0;
    const off = store.subscribe(() => n++);
    generateLog()
      .slice(0, 2)
      .forEach((e) => store.applyEvent(e));
    off();
    store.applyEvent(generateLog()[0]!);
    expect(n).toBe(2);
  });

  it('active combatant selector equals first initiative entry (US-B4 AC3)', () => {
    const store = createGameStore();
    generateLog().forEach((e) => store.applyEvent(e));
    const s = store.getState();
    expect(selectActiveCombatant(s)).toBe(s.combat.initiative[0]!.entityId);
    expect(selectTracker(s).order).toBe(s.combat.initiative);
  });

  it('rejects invalid sequences like the engine', () => {
    expect(() =>
      createGameStore().applyEvent({ type: 'TurnEnded', entityId: 'x' }),
    ).toThrow();
  });
});
