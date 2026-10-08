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
        for (let fx = 0; fx < entity.size; fx++) {
          const p = { x: x + fx, y: y + fy };
          if (
            state.map.palette[grid[p.y * state.map.w + p.x] ?? 0]?.blocksMove
          ) {
            blocked = true;
            break;
          }
          const hostile = state.entities.find(
            (o) =>
              o.id !== entity.id &&
              o.team !== entity.team &&
              p.x >= o.pos.x &&
              p.x < o.pos.x + o.size &&
              p.y >= o.pos.y &&
              p.y < o.pos.y + o.size,
          );
          if (hostile) {
            blocked = true;
            break;
          }
        }
      if (blocked) continue;
      const crossed = state.map.edges.some(
        (e) =>
          ((e.a.x === from.x &&
            e.a.y === from.y &&
            e.b.x === x &&
            e.b.y === y) ||
            (e.b.x === from.x &&
              e.b.y === from.y &&
              e.a.x === x &&
              e.a.y === y)) &&
          (e.kind === 'wall' || (e.kind === 'door' && e.state !== 'open')),
      );
      if (!crossed) result.push({ x, y });
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
