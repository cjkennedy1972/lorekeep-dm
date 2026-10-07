import {
  apply,
  emptyCombatState,
  type CombatEvent,
  type CombatState,
} from '@game/rules-engine';
import type { Battlemap, Character } from '@game/schema';

export interface GameState {
  character: Character | null;
  combat: CombatState;
  battlemap: Battlemap | null;
}

export const initialGameState = (): GameState => ({
  character: null,
  combat: emptyCombatState(),
  battlemap: null,
});

/** Pure: applies one engine event with the shared reducer. Invalid sequences throw, as in the engine. */
export function applyEvent(state: GameState, event: CombatEvent): GameState {
  return { ...state, combat: apply(state.combat, event) };
}

export interface GameStore {
  getState(): GameState;
  subscribe(listener: () => void): () => void;
  applyEvent(event: CombatEvent): void;
  setCharacter(character: Character | null): void;
  setBattlemap(battlemap: Battlemap | null): void;
}

// ponytail: tiny subscribe store (works with useSyncExternalStore); no state lib needed yet.
export function createGameStore(initial = initialGameState()): GameStore {
  let state = initial;
  const listeners = new Set<() => void>();
  const set = (next: GameState) => {
    state = next;
    listeners.forEach((l) => l());
  };
  return {
    getState: () => state,
    subscribe(l) {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    applyEvent: (event) => set(applyEvent(state, event)),
    setCharacter: (character) => set({ ...state, character }),
    setBattlemap: (battlemap) => set({ ...state, battlemap }),
  };
}
