import { rleDecode, type Battlemap, type GridPos } from '@game/schema';
import { CELL_FT, cellKey, type Placed } from './geometry.js';

export type MovementEntity = Placed & {
  id: string;
  team?: string;
  conditions?: readonly string[];
};
export type MovementState = {
  map: Battlemap;
  entities: readonly MovementEntity[];
  resources?: Record<
    string,
    { movementLeft?: number; movementRemaining?: number }
  >;
  conditions?: Record<string, readonly (string | { id: string })[]>;
};
export type MovementError = { error: string; hint: string; reason: string };
export type ReachableCell = { cell: GridPos; cost: number; path: GridPos[] };

const active = (state: MovementState, e: MovementEntity) =>
  new Set([
    ...(e.conditions ?? []),
    ...(state.conditions?.[e.id] ?? []).map((c) =>
      typeof c === 'string' ? c : c.id,
    ),
  ]);
export function movementBudget(
  state: MovementState,
  entity: MovementEntity,
): number {
  const ids = active(state, entity);
  if (ids.has('grappled') || ids.has('restrained')) return 0;
  const r = state.resources?.[entity.id];
  return Math.max(0, r?.movementLeft ?? r?.movementRemaining ?? 0);
}
const terrainGrid = (map: Battlemap) => rleDecode(map.cells);
export function movementCost(
  state: MovementState,
  entity: MovementEntity,
  cell: GridPos,
): number {
  const terrain =
    state.map.palette[
      terrainGrid(state.map)[cell.y * state.map.w + cell.x] ?? 0
    ];
  return (
    CELL_FT *
    (terrain?.moveCost ?? 1) *
    (active(state, entity).has('prone') ? 2 : 1)
  );
}
export function movementNeighbors(
  state: MovementState,
  entity: MovementEntity,
  from: GridPos,
): GridPos[] {
  const grid = terrainGrid(state.map),
    result: GridPos[] = [];
  const blockedEdge = (a: GridPos, b: GridPos) =>
    state.map.edges.some(
      (edge) =>
        ((edge.a.x === a.x &&
          edge.a.y === a.y &&
          edge.b.x === b.x &&
          edge.b.y === b.y) ||
          (edge.b.x === a.x &&
            edge.b.y === a.y &&
            edge.a.x === b.x &&
            edge.a.y === b.y)) &&
        (edge.kind === 'wall' ||
          (edge.kind === 'door' && edge.state !== 'open')),
    );
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const x = from.x + dx,
        y = from.y + dy;
      if (
        x < 0 ||
        y < 0 ||
        x + entity.size > state.map.w ||
        y + entity.size > state.map.h
      )
        continue;
      let blocked = false;
      for (let fy = 0; fy < entity.size && !blocked; fy++)
        for (let fx = 0; fx < entity.size && !blocked; fx++) {
          const previous = { x: from.x + fx, y: from.y + fy };
          const next = { x: x + fx, y: y + fy };
          if (
            state.map.palette[grid[next.y * state.map.w + next.x] ?? 0]
              ?.blocksMove
          ) {
            blocked = true;
            break;
          }
          const hostile = state.entities.find(
            (other) =>
              other.id !== entity.id &&
              other.team !== entity.team &&
              next.x >= other.pos.x &&
              next.x < other.pos.x + other.size &&
              next.y >= other.pos.y &&
              next.y < other.pos.y + other.size,
          );
          if (hostile) {
            blocked = true;
            break;
          }
          if (dx !== 0 && dy !== 0) {
            const horizontalSide = { x: previous.x + dx, y: previous.y };
            const verticalSide = { x: previous.x, y: previous.y + dy };
            if (
              blockedEdge(previous, horizontalSide) ||
              blockedEdge(previous, verticalSide) ||
              blockedEdge(horizontalSide, next) ||
              blockedEdge(verticalSide, next)
            )
              blocked = true;
          } else if (blockedEdge(previous, next)) {
            blocked = true;
          }
        }
      if (!blocked) result.push({ x, y });
    }
  return result;
}

export function reachable(
  state: MovementState,
  entityId: string,
): ReachableCell[] | MovementError {
  const entity = state.entities.find((e) => e.id === entityId);
  if (!entity)
    return {
      error: 'Unknown entity.',
      hint: 'Choose an entity on the map.',
      reason: 'unknown_entity',
    };
  const budget = movementBudget(state, entity),
    first = { cell: entity.pos, cost: 0, path: [entity.pos] };
  const best = new Map([[cellKey(entity.pos), first]]),
    queue = [first];
  while (queue.length) {
    queue.sort((a, b) => a.cost - b.cost);
    const current = queue.shift()!;
    for (const cell of movementNeighbors(state, entity, current.cell)) {
      const occupant = state.entities.find(
        (o) =>
          o.id !== entity.id &&
          cell.x < o.pos.x + o.size &&
          cell.x + entity.size > o.pos.x &&
          cell.y < o.pos.y + o.size &&
          cell.y + entity.size > o.pos.y,
      );
      if (
        occupant &&
        (occupant.team !== entity.team ||
          cell.x !== entity.pos.x ||
          cell.y !== entity.pos.y)
      )
        continue;
      const cost = current.cost + movementCost(state, entity, cell),
        key = cellKey(cell);
      if (cost > budget || (best.has(key) && best.get(key)!.cost <= cost))
        continue;
      const next = { cell, cost, path: [...current.path, cell] };
      best.set(key, next);
      queue.push(next);
    }
  }
  return [...best.values()];
}
export function canEndAt(
  state: MovementState,
  entityId: string,
  goal: GridPos,
): MovementError | null {
  const entity = state.entities.find((e) => e.id === entityId);
  if (!entity)
    return {
      error: 'Unknown entity.',
      hint: 'Choose an entity on the map.',
      reason: 'unknown_entity',
    };
  const occupied = state.entities.some(
    (o) =>
      o.id !== entityId &&
      goal.x < o.pos.x + o.size &&
      goal.x + entity.size > o.pos.x &&
      goal.y < o.pos.y + o.size &&
      goal.y + entity.size > o.pos.y,
  );
  return occupied
    ? {
        error: 'Cannot end movement on an occupied cell.',
        hint: 'Choose an unoccupied destination.',
        reason: 'occupied',
      }
    : null;
}
