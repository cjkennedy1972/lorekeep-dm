import { randomInt } from 'node:crypto';
import { deathSave, freshDeathSaves, type DeathSaves, type RngState } from '@game/rules-engine';

export type DeathResolution = {
  gameState: Record<string, unknown>;
  events: Record<string, unknown>[];
  prompt?: 'death-save' | 'tpk-choice';
};

/** Resolve one server-rolled death save. Client-supplied dice are never accepted. */
export function resolveDeathSave(
  gameState: Record<string, unknown>,
  accountId: string,
  rng: RngState = randomInt(0x1_0000_0000),
): DeathResolution {
  const characters = (gameState.characters ?? {}) as Record<string, { id: string; hp: { current: number; max: number; temp: number } }>;
  const character = characters[accountId];
  if (!character || character.hp.current > 0) throw new Error('No death save is due');
  const records = (gameState.deathSaves ?? {}) as Record<string, DeathSaves>;
  const prior = records[accountId] ?? freshDeathSaves();
  const [result] = deathSave({ ...prior, hp: character.hp.current }, rng);
  if ('error' in result) throw new Error(result.hint);
  const state = result.state;
  const dead = state.dead;
  const events: Record<string, unknown>[] = [
    { type: 'DeathSaveRolled', accountId, die: result.die, state },
  ];
  if (dead) events.push({ type: 'CharacterDied', accountId, entityId: character.id });
  return {
    gameState: {
      ...gameState,
      deathSaves: { ...records, [accountId]: state },
      ...(state.hp > 0 ? { characters: { ...characters, [accountId]: { ...character, hp: { ...character.hp, current: 1 } } } } : {}),
    },
    events,
    prompt: dead ? 'tpk-choice' : state.stable ? undefined : 'death-save',
  };
}

/** Restore a checkpoint and select a different deterministic seed for the retry. */
export function retryFromCheckpoint<T extends object>(checkpoint: T, oldSeed: number, nextSeed = randomInt(0x1_0000_0000)): T & { seed: number } {
  if (nextSeed === oldSeed) nextSeed = (oldSeed + 1) >>> 0;
  return { ...checkpoint, seed: nextSeed };
}

/** Narrative fail-forward is intentionally state/event-only: it performs no RNG operation. */
export function failForward(gameState: Record<string, unknown>, accountId: string, narrative: string) {
  if (!narrative.trim()) throw new Error('A fail-forward narrative is required');
  return {
    gameState: { ...gameState, failForward: { accountId, narrative } },
    events: [{ type: 'FailForwardChosen', accountId, narrative }],
  };
}
