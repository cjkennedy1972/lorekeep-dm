import { randomInt } from 'node:crypto';
import { callForRest, type Catalog, type CharacterInput, type RngState } from '@game/rules-engine';

export type RestResolution = {
  gameState: Record<string, unknown>;
  events: Record<string, unknown>[];
};

/** Apply an engine-defined rest to the seated solo character using a server-generated roll seed. */
export function resolveSoloRest(
  gameState: Record<string, unknown>,
  accountId: string,
  kind: 'short' | 'long',
  catalog: Catalog,
  hitDiceToSpend = 1,
  interruptionChance = 0,
  rng: RngState = randomInt(0x1_0000_0000),
): RestResolution {
  if (!Number.isFinite(interruptionChance) || interruptionChance < 0 || interruptionChance > 1)
    throw new RangeError('Rest interruption chance must be between 0 and 1');
  const characters = (gameState.characters ?? {}) as Record<string, CharacterInput>;
  const character = characters[accountId];
  if (!character) throw new Error('Character is not configured for this seat');
  const result = callForRest(character, kind, catalog, rng, hitDiceToSpend);
  if (!result.ok) throw new Error(result.hint);
  const interrupted = interruptionChance > 0 && randomInt(0x1_0000_0000) / 0x1_0000_0000 < interruptionChance;
  const events: Record<string, unknown>[] = interrupted
    ? [{ type: 'RestInterrupted', entityId: character.id, kind }]
    : [...result.events];
  const nextCharacter = interrupted ? character : result.value.character;
  if (!interrupted) events.push({ type: 'RestCompleted', kind, entityId: character.id });
  return {
    gameState: {
      ...gameState,
      characters: { ...characters, [accountId]: nextCharacter },
      gameEngine: gameState.gameEngine && typeof gameState.gameEngine === 'object'
        ? { ...(gameState.gameEngine as Record<string, unknown>), actors: { ...((gameState.gameEngine as { actors?: object }).actors ?? {}), [character.id]: nextCharacter } }
        : gameState.gameEngine,
    },
    events,
  };
}
