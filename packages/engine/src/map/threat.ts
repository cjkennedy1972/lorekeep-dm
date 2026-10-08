import { inReach, type DiagonalRule } from './geometry.js';
import type { MovementEntity } from './reachable.js';

export type ThreatEntity = MovementEntity & { team?: string };

/** Hostile creatures whose melee reach contains the subject. */
export function threatenedBy<T extends ThreatEntity>(
  entity: T,
  entities: readonly T[],
  reachFt = 5,
  rule: DiagonalRule = '5ft',
): T[] {
  return entities
    .filter(
      (other) =>
        other.id !== entity.id &&
        other.team !== entity.team &&
        inReach(entity, other, reachFt, rule),
    )
    .sort((a, b) => a.id.localeCompare(b.id));
}
