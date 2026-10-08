import type { GridPos } from '@game/schema';
import { cellKey } from './geometry.js';
import {
  canEndAt,
  movementCost,
  movementNeighbors,
  movementBudget,
  type MovementError,
  type MovementState,
} from './reachable.js';

export type PathResult = { path: GridPos[]; cost: number } | MovementError;
export function path(
  state: MovementState,
  entityId: string,
  goal: GridPos,
): PathResult {
  const entity = state.entities.find((e) => e.id === entityId);
  if (!entity)
    return {
      error: 'Unknown entity.',
      hint: 'Choose an entity on the map.',
      reason: 'unknown_entity',
    };
  const endError = canEndAt(state, entityId, goal);
  if (endError) return endError;
  const budget = movementBudget(state, entity),
    start = entity.pos;
  const open = [start],
    came = new Map<string, GridPos>(),
    costs = new Map([[cellKey(start), 0]]);
  const heuristic = (p: GridPos) =>
    Math.max(Math.abs(goal.x - p.x), Math.abs(goal.y - p.y)) * 5;
  while (open.length) {
    open.sort(
      (a, b) =>
        costs.get(cellKey(a))! +
        heuristic(a) -
        (costs.get(cellKey(b))! + heuristic(b)),
    );
    const current = open.shift()!,
      key = cellKey(current),
      currentCost = costs.get(key)!;
    if (current.x === goal.x && current.y === goal.y) {
      const points = [goal];
      let cursor = goal;
      while (cellKey(cursor) !== cellKey(start)) {
        cursor = came.get(cellKey(cursor))!;
        points.push(cursor);
      }
      return { path: points.reverse(), cost: currentCost };
    }
    for (const next of movementNeighbors(state, entity, current)) {
      const occupant = state.entities.find(
        (o) =>
          o.id !== entityId &&
          next.x < o.pos.x + o.size &&
          next.x + entity.size > o.pos.x &&
          next.y < o.pos.y + o.size &&
          next.y + entity.size > o.pos.y,
      );
      if (
        occupant &&
        (occupant.team !== entity.team ||
          next.x !== start.x ||
          next.y !== start.y)
      )
        continue;
      const nextKey = cellKey(next),
        cost = currentCost + movementCost(state, entity, next);
      if (cost > budget || cost >= (costs.get(nextKey) ?? Infinity)) continue;
      costs.set(nextKey, cost);
      came.set(nextKey, current);
      if (!open.some((p) => cellKey(p) === nextKey)) open.push(next);
    }
  }
  return {
    error: 'Goal is unreachable within remaining movement.',
    hint: 'Choose a reachable, unoccupied cell and check terrain or doors.',
    reason: 'unreachable',
  };
}
