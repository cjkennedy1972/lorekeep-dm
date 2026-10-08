import { createGameStore } from './gameStore';

/** Shared in-memory game state for screens in this browser session. */
export const gameStore = createGameStore();
