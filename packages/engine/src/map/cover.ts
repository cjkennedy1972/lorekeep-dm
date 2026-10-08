import type { Battlemap, Cell, Cover } from '@game/schema';
import { cellKey, footprint, type Placed } from './geometry.js';

export type CoverGrade = Cover;
export type CoverKind = 'attack' | 'save';

export interface CoverResult {
  grade: CoverGrade;
  acBonus: 0 | 2 | 5;
  saveBonus: 0 | 2 | 5;
  bonus: 0 | 2 | 5;
  display: string;
  targetable: boolean;
  error?: 'no line';
  blockedLines: number;
  totalLines: number;
}

const rank: Record<CoverGrade, number> = {
  none: 0,
  half: 1,
  'three-quarters': 2,
  full: 3,
};
const bonusFor: Record<CoverGrade, 0 | 2 | 5> = {
  none: 0,
  half: 2,
  'three-quarters': 5,
  full: 5,
};
const edgeKey = (a: Cell, b: Cell): string => {
  const first = cellKey(a),
    second = cellKey(b);
  return first < second ? `${first}|${second}` : `${second}|${first}`;
};
function decode(map: Battlemap): number[] {
  const out: number[] = [];
  for (let i = 0; i < map.cells.length; i += 2)
    for (let n = 0; n < map.cells[i + 1]!; n++) out.push(map.cells[i]!);
  return out;
}
function cellCover(
  map: Battlemap,
  cells: readonly number[],
  c: Cell,
): CoverGrade {
  if (c.x < 0 || c.y < 0 || c.x >= map.w || c.y >= map.h) return 'full';
  let result = map.palette[cells[c.y * map.w + c.x] ?? -1]?.cover ?? 'full';
  for (const feature of map.features) {
    if (!feature.cells.some((fc) => fc.x === c.x && fc.y === c.y)) continue;
    const featureGrade: CoverGrade = feature.tags.includes('full-cover')
      ? 'full'
      : feature.tags.includes('three-quarters-cover')
        ? 'three-quarters'
        : feature.tags.includes('half-cover') || feature.tags.includes('cover')
          ? 'half'
          : 'none';
    if (rank[featureGrade] > rank[result]) result = featureGrade;
  }
  return result;
}

/** Whether every footprint ray is blocked by an obstruction providing Total Cover. */
export function totalCoverBetween(
  map: Battlemap,
  a: Placed,
  b: Placed,
): boolean {
  const terrain = decode(map);
  const blockedEdges = new Set(
    map.edges
      .filter(
        (e) => e.kind === 'wall' || (e.kind === 'door' && e.state !== 'open'),
      )
      .map((e) => edgeKey(e.a, e.b)),
  );
  const blocks = (cell: Cell) => cellCover(map, terrain, cell) === 'full';
  const clearRay = (start: Cell, end: Cell): boolean => {
    let x = start.x,
      y = start.y;
    const dx = end.x - x,
      dy = end.y - y;
    const nx = Math.abs(dx),
      ny = Math.abs(dy),
      sx = Math.sign(dx),
      sy = Math.sign(dy);
    let ix = 0,
      iy = 0,
      previous: Cell = { x, y };
    while (ix < nx || iy < ny) {
      const decision = (1 + 2 * ix) * ny - (1 + 2 * iy) * nx;
      if (decision === 0) {
        const h = { x: x + sx, y },
          v = { x, y: y + sy },
          d = { x: x + sx, y: y + sy };
        const laneClear = (mid: Cell) =>
          !blockedEdges.has(edgeKey(previous, mid)) &&
          !blockedEdges.has(edgeKey(mid, d)) &&
          !blocks(mid);
        if (!laneClear(h) && !laneClear(v)) return false;
        x = d.x;
        y = d.y;
        ix++;
        iy++;
        previous = d;
      } else {
        const next = decision < 0 ? { x: x + sx, y } : { x, y: y + sy };
        if (blockedEdges.has(edgeKey(previous, next)) || blocks(next))
          return false;
        x = next.x;
        y = next.y;
        if (decision < 0) ix++;
        else iy++;
        previous = next;
      }
    }
    return true;
  };
  return !footprint(a).some((start) =>
    footprint(b).some((end) => clearRay(start, end)),
  );
}

/** Trace all occupied cell-center rays; the clearest ray determines direct cover. */
export function coverBetween(
  map: Battlemap,
  a: Placed,
  b: Placed,
  creatures: readonly (Placed & { id?: string })[] = [],
): CoverResult {
  const terrain = decode(map);
  const blockedEdges = new Set(
    map.edges
      .filter(
        (e) => e.kind === 'wall' || (e.kind === 'door' && e.state !== 'open'),
      )
      .map((e) => edgeKey(e.a, e.b)),
  );
  const creatureCells = new Set(
    creatures.flatMap((creature) => footprint(creature).map(cellKey)),
  );
  const trace = (start: Cell, end: Cell): CoverGrade => {
    let x = start.x,
      y = start.y;
    const dx = end.x - x,
      dy = end.y - y;
    const nx = Math.abs(dx),
      ny = Math.abs(dy),
      sx = Math.sign(dx),
      sy = Math.sign(dy);
    let ix = 0,
      iy = 0,
      strongest: CoverGrade = 'none';
    let previous: Cell = { x, y };
    const add = (g: CoverGrade) => {
      if (rank[g] > rank[strongest]) strongest = g;
    };
    while (ix < nx || iy < ny) {
      const decision = (1 + 2 * ix) * ny - (1 + 2 * iy) * nx;
      if (decision === 0) {
        const h: Cell = { x: x + sx, y },
          v: Cell = { x, y: y + sy },
          d: Cell = { x: x + sx, y: y + sy };
        const lane = (mid: Cell): CoverGrade =>
          blockedEdges.has(edgeKey(previous, mid)) ||
          blockedEdges.has(edgeKey(mid, d))
            ? 'full'
            : cellCover(map, terrain, mid);
        const hg = lane(h),
          vg = lane(v);
        add(rank[hg] <= rank[vg] ? hg : vg);
        if (creatureCells.has(cellKey(h)) || creatureCells.has(cellKey(v)))
          add('half');
        x = d.x;
        y = d.y;
        ix++;
        iy++;
        previous = d;
      } else if (decision < 0) {
        const next: Cell = { x: x + sx, y };
        add(
          blockedEdges.has(edgeKey(previous, next))
            ? 'full'
            : creatureCells.has(cellKey(next))
              ? 'half'
              : cellCover(map, terrain, next),
        );
        x = next.x;
        ix++;
        previous = next;
      } else {
        const next: Cell = { x, y: y + sy };
        add(
          blockedEdges.has(edgeKey(previous, next))
            ? 'full'
            : creatureCells.has(cellKey(next))
              ? 'half'
              : cellCover(map, terrain, next),
        );
        y = next.y;
        iy++;
        previous = next;
      }
    }
    return strongest;
  };
  const from = footprint(a),
    to = footprint(b);
  let best: CoverGrade = 'full',
    blockedLines = 0,
    totalLines = 0;
  for (const start of from)
    for (const end of to) {
      const line = trace(start, end);
      totalLines++;
      if (line !== 'none') blockedLines++;
      if (rank[line] < rank[best]) best = line;
    }
  const bonus = bonusFor[best],
    targetable = best !== 'full';
  return {
    grade: best,
    acBonus: bonus,
    saveBonus: best === 'full' ? 0 : bonus,
    bonus,
    display: best === 'none' ? 'cover: none' : `cover: ${best} (+${bonus} AC)`,
    targetable,
    ...(targetable ? {} : { error: 'no line' as const }),
    blockedLines,
    totalLines,
  };
}

export function coverBonus(
  result: CoverResult,
  kind: CoverKind = 'attack',
): 0 | 2 | 5 {
  return kind === 'attack' ? result.acBonus : result.saveBonus;
}
