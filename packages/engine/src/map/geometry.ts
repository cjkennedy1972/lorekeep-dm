import type { Battlemap, GridPos } from '@game/schema';

/**
 * Grid geometry on the 5 ft square grid (ADR-018). Pure and deterministic.
 *
 * Diagonal convention (map `diagonalRule`):
 * - '5ft' (default): every step, including diagonals, costs 5 ft, so the
 *   distance between cells is Chebyshev distance x 5.
 * - 'alternate': the 5-10-5 variant; diagonals alternate 5 ft and 10 ft.
 *
 * OPEN ITEM (docs/decisions.md): the SRD 5.2.1 text has not been read to
 * confirm that 5 ft per diagonal is its default. Treated as unconfirmed.
 *
 * Distance between entities is the minimum cell-to-cell distance across their
 * footprints, so adjacent creatures (of any size) are 5 ft apart. That
 * footprint minimum is not a metric (a Large entity can be near two others
 * that are far apart); symmetry and the triangle inequality hold for cells.
 */
export const CELL_FT = 5;

export type DiagonalRule = Battlemap['diagonalRule'];

export interface Placed {
  pos: GridPos;
  /** Footprint in cells per side. */
  size: number;
}

export type RangeBand = 'normal' | 'long' | 'out';

export const cellKey = (c: GridPos): string => `${c.x},${c.y}`;

/** Cells covered by an entity; `pos` is the top-left cell of the footprint. */
export function footprint(e: Placed): GridPos[] {
  const cells: GridPos[] = [];
  for (let dy = 0; dy < e.size; dy++)
    for (let dx = 0; dx < e.size; dx++)
      cells.push({ x: e.pos.x + dx, y: e.pos.y + dy });
  return cells;
}

/** Distance in feet between two single cells. */
export function cellDistance(
  a: GridPos,
  b: GridPos,
  rule: DiagonalRule = '5ft',
): number {
  const dx = Math.abs(a.x - b.x);
  const dy = Math.abs(a.y - b.y);
  const diag = Math.min(dx, dy);
  const steps = Math.max(dx, dy);
  return CELL_FT * (rule === '5ft' ? steps : steps + Math.floor(diag / 2));
}

/** Distance in feet between two entities (nearest footprint cells). */
export function distance(
  a: Placed,
  b: Placed,
  rule: DiagonalRule = '5ft',
): number {
  const fb = footprint(b);
  let best = Infinity;
  for (const ca of footprint(a))
    for (const cb of fb) best = Math.min(best, cellDistance(ca, cb, rule));
  return best;
}

/** Occupancy index: cell key -> id of the entity covering it. */
export function occupancyIndex(
  entities: readonly (Placed & { id: string })[],
): Map<string, string> {
  const idx = new Map<string, string>();
  for (const e of entities)
    for (const c of footprint(e)) idx.set(cellKey(c), e.id);
  return idx;
}

/** True if `e` placed at `pos` overlaps a cell held by anyone but `ignoreId`. */
export function isBlocked(
  index: ReadonlyMap<string, string>,
  e: Placed,
  ignoreId?: string,
): boolean {
  return footprint(e).some((c) => {
    const holder = index.get(cellKey(c));
    return holder !== undefined && holder !== ignoreId;
  });
}

/** Melee reach predicate (default reach 5 ft). */
export function inReach(
  a: Placed,
  b: Placed,
  reachFt = CELL_FT,
  rule: DiagonalRule = '5ft',
): boolean {
  return distance(a, b, rule) <= reachFt;
}

/** Range band for a ranged attack: within normal, within long (disadvantage), or out. */
export function rangeBand(
  distFt: number,
  normalFt: number,
  longFt: number = normalFt,
): RangeBand {
  if (distFt <= normalFt) return 'normal';
  return distFt <= longFt ? 'long' : 'out';
}
