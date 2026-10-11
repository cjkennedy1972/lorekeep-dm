import { checkHardFloor, createHardFloorTurn } from './hardFloor.js';
import type {
  DeterministicCheckResult,
  DeterministicLayer,
} from './moderator.js';

const toCheck = (blocked: boolean): DeterministicCheckResult =>
  blocked ? { blocked: true, category: 'minor_sexual' } : { blocked: false };

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
    return { push: (text) => toCheck(turn.push(text).blocked) };
  },
  denylistCheck: () => ({ blocked: false }),
  maxSpanChars: 0,
};
