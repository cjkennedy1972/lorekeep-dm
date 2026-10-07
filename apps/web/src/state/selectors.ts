import type { GameState } from './gameStore';

export const selectSheet = (s: GameState) => s.character;
export const selectMap = (s: GameState) => s.battlemap;

/** Tracker: initiative order plus round. */
export const selectTracker = (s: GameState) => ({
  round: s.combat.round,
  order: s.combat.initiative,
});

/** US-B4 AC3: the active combatant is the first entry of the initiative order. */
export const selectActiveCombatant = (s: GameState): string | null =>
  s.combat.initiative[0]?.entityId ?? null;
