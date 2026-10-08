import type { Catalog } from '../catalog/types.js';
import {
  longRest,
  recoverShortRestFeatures,
  shortRest,
} from '../character/rest.js';
import type { CharacterInput } from '../character/types.js';
import type { RngState } from '../rng.js';
import type { DMToolErrorCode } from '@game/schema';

export type RestEvent =
  | {
      type: 'ShortRestCompleted';
      entityId: string;
      hitDiceSpent: number;
      rolls: ReturnType<typeof shortRest>['rolls'];
    }
  | { type: 'LongRestCompleted'; entityId: string };
export type RestOutcome = { character: CharacterInput; rng: RngState };
export type RestToolResult =
  | { ok: true; value: RestOutcome; events: RestEvent[]; summary: string }
  | { ok: false; error: DMToolErrorCode; hint: string };

export function callForRest(
  character: CharacterInput,
  kind: 'short' | 'long',
  catalog: Catalog,
  rng: RngState,
  hitDiceToSpend = 1,
): RestToolResult {
  if (kind === 'short') {
    const available = character.level - (character.hitDiceSpent ?? 0);
    if (
      !Number.isInteger(hitDiceToSpend) ||
      hitDiceToSpend < 0 ||
      hitDiceToSpend > available
    )
      return {
        ok: false,
        error: 'illegal-transition',
        hint: `Spend between 0 and ${Math.max(0, available)} Hit Dice.`,
      };
    try {
      const rested = shortRest(character, catalog, rng, hitDiceToSpend);
      const recovered = recoverShortRestFeatures(rested.character);
      return {
        ok: true,
        value: { character: recovered, rng: rested.rng },
        events: [
          {
            type: 'ShortRestCompleted',
            entityId: character.id,
            hitDiceSpent: hitDiceToSpend,
            rolls: rested.rolls,
          },
        ],
        summary: `Completed a short rest and spent ${hitDiceToSpend} Hit Dice.`,
      };
    } catch (error) {
      return {
        ok: false,
        error: 'illegal-transition',
        hint:
          error instanceof Error
            ? error.message
            : 'The short rest is not legal.',
      };
    }
  }
  return {
    ok: true,
    value: { character: longRest(character, catalog), rng },
    events: [{ type: 'LongRestCompleted', entityId: character.id }],
    summary: 'Completed a long rest and recovered eligible resources.',
  };
}
