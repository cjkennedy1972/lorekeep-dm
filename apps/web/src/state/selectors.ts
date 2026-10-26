import type { GameState } from './gameStore';

export const selectSheet = (s: GameState) => s.character;
export const selectMap = (s: GameState) => s.battlemap;

/** Tracker: initiative order plus round. */
export const selectTracker = (s: GameState) => ({
  round: s.combat.round,
  order: s.combat.initiative,
});

/** The server names the active combatant; null (a creature hidden from this viewer is acting) means none, never initiative[0]. */
export const selectActiveCombatant = (s: GameState): string | null =>
  s.combat.activeEntityId;
