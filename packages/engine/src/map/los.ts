import type { Battlemap, Cell, Edge } from '@game/schema';
import { cellKey, footprint, type Placed } from './geometry.js';

const edgeKey = (a: Cell, b: Cell): string => {
  const first = cellKey(a);
  const second = cellKey(b);
  return first < second ? `${first}|${second}` : `${second}|${first}`;
};

function decodeTerrain(map: Battlemap): boolean[] {
  const result: boolean[] = [];
  for (let i = 0; i < map.cells.length; i += 2) {
    const blocksSight = map.palette[map.cells[i]!]!.blocksSight;
    for (let n = 0; n < map.cells[i + 1]!; n++) result.push(blocksSight);
  }
  return result;
}

function blockers(map: Battlemap): ReadonlyMap<string, Edge> {
  return new Map(
    map.edges
      .filter(
        (edge) =>
          edge.kind === 'wall' ||
          (edge.kind === 'door' && edge.state !== 'open'),
      )
      .map((edge) => [edgeKey(edge.a, edge.b), edge]),
  );
}

function edgeBlocked(
  edges: ReadonlyMap<string, Edge>,
  a: Cell,
  b: Cell,
): boolean {
  return edges.has(edgeKey(a, b));
}

/**
 * Test sight between two occupied footprints. Each pair of footprint cells is
 * joined center-to-center; at a grid-corner crossing both possible lanes are
 * considered, so sight can go around a corner if either lane is clear.
 *
 *     +---+---+
 *     | A |   |
 *     +---+---+  <- corner crossing checks both lanes
 *     |   | B |
 *     +---+---+
 *
 * A ray is blocked by sight-blocking terrain in an intermediate cell, a wall
 * boundary, or a closed/locked door. Endpoint cells themselves do not block
 * their occupants' sight. Windows and open doors transmit sight.
 */
export function hasLineOfSight(map: Battlemap, a: Placed, b: Placed): boolean {
  const sightBlocking = decodeTerrain(map);
  const blockedEdges = blockers(map);
  const isTerrainBlocked = (cell: Cell) => {
    if (cell.x < 0 || cell.y < 0 || cell.x >= map.w || cell.y >= map.h)
      return true;
    return sightBlocking[cell.y * map.w + cell.x] ?? true;
  };

  const directedRayClear = (start: Cell, end: Cell): boolean => {
    let x = start.x;
    let y = start.y;
    const dx = end.x - x;
    const dy = end.y - y;
    const nx = Math.abs(dx);
    const ny = Math.abs(dy);
    const sx = Math.sign(dx);
    const sy = Math.sign(dy);
    let ix = 0;
    let iy = 0;
    let previous: Cell = { x, y };

    while (ix < nx || iy < ny) {
      const decision = (1 + 2 * ix) * ny - (1 + 2 * iy) * nx;
      if (decision === 0) {
        const horizontal: Cell = { x: x + sx, y };
        const vertical: Cell = { x, y: y + sy };
        const diagonal: Cell = { x: x + sx, y: y + sy };
        const horizontalLane =
          !edgeBlocked(blockedEdges, previous, horizontal) &&
          !edgeBlocked(blockedEdges, horizontal, diagonal) &&
          !isTerrainBlocked(horizontal);
        const verticalLane =
          !edgeBlocked(blockedEdges, previous, vertical) &&
          !edgeBlocked(blockedEdges, vertical, diagonal) &&
          !isTerrainBlocked(vertical);
        if (!horizontalLane && !verticalLane) return false;
        x = diagonal.x;
        y = diagonal.y;
        ix++;
        iy++;
        previous = diagonal;
      } else if (decision < 0) {
        const next: Cell = { x: x + sx, y };
        if (edgeBlocked(blockedEdges, previous, next) || isTerrainBlocked(next))
          return false;
        x = next.x;
        ix++;
        previous = next;
      } else {
        const next: Cell = { x, y: y + sy };
        if (edgeBlocked(blockedEdges, previous, next) || isTerrainBlocked(next))
          return false;
        y = next.y;
        iy++;
        previous = next;
      }
    }
    return true;
  };

  // Choosing the more permissive direction at exact corner ties makes the
  // center-to-center visibility relation symmetric by construction.
  const rayClear = (start: Cell, end: Cell): boolean =>
    directedRayClear(start, end) || directedRayClear(end, start);

  const from = footprint(a);
  const to = footprint(b);
  return from.some((start) => to.some((end) => rayClear(start, end)));
}
