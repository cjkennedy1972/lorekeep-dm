import { checkHardFloor } from './hardFloor.js';
import type { DeterministicLayer } from './moderator.js';

/**
 * Hard floor as the moderator's deterministic layer. Its rules are message-level (a minor
 * reference and a sexual term anywhere in the same text), so no finite span bounds them:
 * maxSpanChars is 0, meaning the per-chunk hold-back does not cover this layer. Coverage
 * comes from the turn-scoped text passed as ModerationRequest.turnContext.
 */
export const hardFloorLayer: DeterministicLayer = {
  hardFloorCheck: (text) =>
    checkHardFloor(text).blocked
      ? { blocked: true, category: 'minor_sexual' }
      : { blocked: false },
  denylistCheck: () => ({ blocked: false }),
  maxSpanChars: 0,
};
