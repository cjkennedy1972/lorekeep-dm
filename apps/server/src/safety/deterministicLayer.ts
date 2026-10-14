import { denylist } from '@game/rules-engine';
import { checkHardFloor, createHardFloorTurn } from './hardFloor.js';
import type {
  DeterministicCheckResult,
  DeterministicLayer,
} from './moderator.js';

const toCheck = (blocked: boolean): DeterministicCheckResult =>
  blocked ? { blocked: true, category: 'minor_sexual' } : { blocked: false };

const denylistPatterns = denylist.map(
  (term) =>
    new RegExp(
      `(^|[^\\p{L}\\p{N}])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').toLocaleLowerCase('en-US')}($|[^\\p{L}\\p{N}])`,
      'u',
    ),
);

const denylistCheck = (text: string): DeterministicCheckResult => {
  const normalized = text.toLocaleLowerCase('en-US');
  return {
    blocked: denylistPatterns.some((pattern) => pattern.test(normalized)),
  };
};

/**
 * Hard floor as the moderator's deterministic layer. Its rules are message-level (a minor
 * reference and a sexual term anywhere in the same turn), so no finite span bounds them:
 * maxSpanChars is 0, meaning the per-chunk hold-back does not cover this layer. Coverage
 * comes from the turn scanner, which the output gate feeds every chunk of one attempt.
 */
export const hardFloorLayer: DeterministicLayer = {
  hardFloorCheck: (text) => toCheck(checkHardFloor(text).blocked),
  startTurn: () => {
    const turn = createHardFloorTurn();
    return {
      push: (text) => {
        const { blocked, sensitive } = turn.push(text);
        return { ...toCheck(blocked), sensitive };
      },
      finish: () => {
        const { blocked, sensitive } = turn.finish();
        return { ...toCheck(blocked), sensitive };
      },
    };
  },
  denylistCheck,
  maxSpanChars: 0,
};
