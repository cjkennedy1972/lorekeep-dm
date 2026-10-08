import { rleDecode, type Battlemap, type GridPos } from '@game/schema';
import { cellKey, type Placed } from './geometry.js';
import { coverBetween, totalCoverBetween } from './cover.js';

export type AreaShape =
  | 'sphere'
  | 'cube'
  | 'cone'
  | 'line'
  | 'cylinder'
  | 'emanation';
export interface AreaTemplate {
  shape: AreaShape;
  /** Radius for sphere/cylinder; edge for cube; length for cone/line, in feet. */
  size: number;
  width?: number;
  height?: number;
  /** Include the origin square for shapes whose creator may exclude it. */
  includeOrigin?: boolean;
}
export interface AreaState {
  map: Battlemap;
  entities: readonly (Placed & { id: string })[];
}
export interface AffectedEntity {
  id: string;
  saveBonus: number;
}
const cellOrder = (a: GridPos, b: GridPos) => a.y - b.y || a.x - b.x;
const inside = (map: Battlemap, c: GridPos) =>
  c.x >= 0 && c.y >= 0 && c.x < map.w && c.y < map.h;
const key = (c: GridPos) => cellKey(c);
function dirVector(direction: GridPos): GridPos {
  const d = { x: Math.sign(direction.x), y: Math.sign(direction.y) };
  if (!d.x && !d.y) throw new Error('Area direction must be non-zero.');
  return d;
}
function lineOfEffect(map: Battlemap, origin: GridPos, cell: GridPos) {
  return (
    key(origin) === key(cell) ||
    !totalCoverBetween(map, { pos: origin, size: 1 }, { pos: cell, size: 1 })
  );
}
function circleContains(a: GridPos, b: GridPos, radiusFt: number) {
  const dx = (a.x - b.x) * 5,
    dy = (a.y - b.y) * 5;
  return dx * dx + dy * dy <= radiusFt * radiusFt;
}

/**
 * Deterministic planar rasterization: cells are 5-ft squares represented by
 * centers, output is row-major. Sphere/cylinder use Euclidean radius; cube is
 * centered by default or placed against a face in the chosen direction; cone
 * width equals its length at each distance; line is 5 ft wide by default.
 * Emanation uses a Euclidean radius. Only Total Cover blocks areas. `height`
 * is ignored on this 2-D map.
 */
export function areaCells(
  map: Battlemap,
  template: AreaTemplate,
  origin: GridPos,
  direction: GridPos = { x: 1, y: 0 },
): GridPos[] {
  if (!Number.isFinite(template.size) || template.size <= 0)
    throw new Error('Area size must be positive.');
  const dir = dirVector(direction);
  const radius = template.size / 5,
    extent = Math.ceil(radius + 1);
  const candidates: GridPos[] = [];
  for (
    let y = Math.max(0, origin.y - extent);
    y <= Math.min(map.h - 1, origin.y + extent);
    y++
  )
    for (
      let x = Math.max(0, origin.x - extent);
      x <= Math.min(map.w - 1, origin.x + extent);
      x++
    ) {
      const c = { x, y },
        dx = x - origin.x,
        dy = y - origin.y;
      const forward = dx * dir.x + dy * dir.y,
        lateral = Math.abs(dx * dir.y - dy * dir.x);
      const orientedForwardFt =
        Math.hypot(dir.x, dir.y) === Math.SQRT2
          ? (forward * 5) / Math.SQRT2
          : forward * 5;
      let include = false;
      switch (template.shape) {
        case 'sphere':
        case 'cylinder':
        case 'emanation':
          include = circleContains(origin, c, template.size);
          break;
        case 'cube': {
          if (template.includeOrigin !== false) {
            const side = Math.max(1, Math.ceil(template.size / 5));
            const start = -Math.floor(side / 2);
            include =
              dx >= start &&
              dx < start + side &&
              dy >= start &&
              dy < start + side;
            break;
          }
          const side = Math.max(1, Math.ceil(template.size / 5));
          const forward = dx * dir.x + dy * dir.y;
          const lateral = dx * dir.y - dy * dir.x;
          // A directional cube begins at its origin face and extends forward.
          const start =
            template.includeOrigin === false ? 0 : -Math.floor(side / 2);
          include =
            forward >= start &&
            forward < start + side &&
            Math.abs(lateral) <= Math.floor((side - 1) / 2);
          break;
        }
        case 'cone': {
          const range = Math.max(Math.abs(dx), Math.abs(dy));
          const forwardDot = dx * dir.x + dy * dir.y;
          include =
            range <= radius &&
            ((forwardDot > 0 && lateral <= forwardDot / 2) ||
              (template.includeOrigin === true && dx === 0 && dy === 0));
          break;
        }
        case 'line': {
          const width = Math.max(1, Math.ceil((template.width ?? 5) / 5));
          include =
            forward > 0 &&
            orientedForwardFt > 0 &&
            orientedForwardFt <= template.size &&
            (width % 2 === 0
              ? Math.abs(lateral) > (width - 2) / 2 &&
                Math.abs(lateral) <= width / 2
              : Math.abs(lateral) <= (width - 1) / 2);
          break;
        }
      }
      if (include) candidates.push(c);
    }
  const walkable = (c: GridPos) => inside(map, c);
  const candidateKeys = new Set(candidates.map(key));
  const originMayBeIncluded =
    template.shape !== 'cone' &&
    template.shape !== 'line' &&
    !(template.shape === 'cube' && template.includeOrigin === false) &&
    !(template.shape === 'emanation' && template.includeOrigin === false);
  const reached = new Set<string>(originMayBeIncluded ? [key(origin)] : []);
  if (template.shape === 'sphere') {
    const queue = originMayBeIncluded ? [origin] : [];
    for (let head = 0; head < queue.length; head++) {
      const current = queue[head]!;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const next = { x: current.x + dx, y: current.y + dy },
            nextKey = key(next);
          if (
            !candidateKeys.has(nextKey) ||
            reached.has(nextKey) ||
            !walkable(next)
          )
            continue;
          // A diagonal transition may pass the corner if at least one lane is open.
          if (dx && dy) {
            const sideA = { x: current.x + dx, y: current.y },
              sideB = { x: current.x, y: current.y + dy };
            const laneA =
              walkable(sideA) &&
              lineOfEffect(map, origin, sideA) &&
              lineOfEffect(map, sideA, next);
            const laneB =
              walkable(sideB) &&
              lineOfEffect(map, origin, sideB) &&
              lineOfEffect(map, sideB, next);
            if (!laneA && !laneB) continue;
          } else if (!lineOfEffect(map, current, next)) continue;
          if (!lineOfEffect(map, origin, next)) continue;
          reached.add(nextKey);
          queue.push(next);
        }
    }
  } else {
    for (const c of candidates)
      if (
        (key(c) === key(origin) && originMayBeIncluded) ||
        (key(c) !== key(origin) && walkable(c) && lineOfEffect(map, origin, c))
      )
        reached.add(key(c));
  }
  return candidates.filter((c) => reached.has(key(c))).sort(cellOrder);
}

function coverBonus(map: Battlemap, origin: GridPos, target: Placed): number {
  const result = coverBetween(map, { pos: origin, size: 1 }, target);
  let bonus =
    result.grade === 'three-quarters' ? 5 : result.grade === 'half' ? 2 : 0;
  // Cover in the target's own occupied squares is explicitly represented by terrain.
  const decoded = rleDecode(map.cells);
  for (let y = 0; y < target.size; y++)
    for (let x = 0; x < target.size; x++) {
      const cell = { x: target.pos.x + x, y: target.pos.y + y };
      const grade = map.palette[decoded[cell.y * map.w + cell.x] ?? 0]?.cover;
      bonus = Math.max(
        bonus,
        grade === 'three-quarters' ? 5 : grade === 'half' ? 2 : 0,
      );
    }
  return bonus;
}
/** Return intersecting entities once, sorted by id, with their cover bonus
 * (+2 half, +5 three-quarters; full cover prevents area inclusion via LOS). */
export function affectedEntities(
  cells: readonly GridPos[],
  state: AreaState,
  origin: GridPos,
): AffectedEntity[] {
  const area = new Set(cells.map(key));
  return state.entities
    .filter((entity) => {
      for (let y = 0; y < entity.size; y++)
        for (let x = 0; x < entity.size; x++)
          if (area.has(key({ x: entity.pos.x + x, y: entity.pos.y + y })))
            return true;
      return false;
    })
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((entity) => ({
      id: entity.id,
      saveBonus: coverBonus(state.map, origin, entity),
    }));
}
