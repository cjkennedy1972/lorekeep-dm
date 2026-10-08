import { rleEncode, type Battlemap } from '@game/schema';
import { describe, expect, test } from 'vitest';
import {
  canEndAt,
  reachable,
  type MovementState,
} from '../src/map/reachable.js';
import { path } from '../src/map/path.js';

const palette = [
  {
    terrainId: 'floor',
    moveCost: 1,
    blocksMove: false,
    blocksSight: false,
    cover: 'none' as const,
    elevation: 0,
  },
  {
    terrainId: 'mud',
    moveCost: 2,
    blocksMove: false,
    blocksSight: false,
    cover: 'none' as const,
    elevation: 0,
  },
  {
    terrainId: 'wall',
    moveCost: 1,
    blocksMove: true,
    blocksSight: true,
    cover: 'full' as const,
    elevation: 0,
  },
];
function fixture(): MovementState {
  const cells = Array(25).fill(0);
  cells[2 * 5 + 2] = 1;
  cells[1 * 5 + 3] = 2;
  const map: Battlemap = {
    mapId: 'm',
    w: 5,
    h: 5,
    palette,
    cells: rleEncode(cells),
    edges: [],
    features: [],
    markers: [],
    zones: [],
    diagonalRule: '5ft',
  };
  return {
    map,
    entities: [
      { id: 'a', pos: { x: 0, y: 0 }, size: 1, team: 'heroes' },
      { id: 'ally', pos: { x: 1, y: 0 }, size: 1, team: 'heroes' },
    ],
    resources: { a: { movementLeft: 30 } },
  };
}
describe('tactical movement pathfinding', () => {
  test('difficult terrain costs 10 feet and paths stay within budget', () => {
    const s = fixture();
    const cells = Array(25).fill(2);
    cells[0] = 0;
    cells[1] = 0;
    cells[2] = 0;
    s.map.cells = rleEncode(cells);
    s.entities = [s.entities[0]!];
    const result = reachable(s, 'a');
    expect(Array.isArray(result)).toBe(true);
    if (!Array.isArray(result)) return;
    expect(result.find((r) => r.cell.x === 2 && r.cell.y === 0)?.cost).toBe(10);
    for (const r of result) expect(r.cost).toBeLessThanOrEqual(30);
  });
  test('mud (moveCost 2) costs 10 feet to enter', () => {
    const s = fixture();
    s.entities = [s.entities[0]!];
    const result = reachable(s, 'a');
    expect(Array.isArray(result)).toBe(true);
    if (!Array.isArray(result)) return;
    // (0,0) -> (1,1) floor 5ft -> (2,2) mud 10ft
    expect(result.find((r) => r.cell.x === 2 && r.cell.y === 2)?.cost).toBe(15);
    // mud is entered at double cost: (3,3) is one more diagonal floor step
    expect(result.find((r) => r.cell.x === 3 && r.cell.y === 3)?.cost).toBe(20);
  });
  test('closed doors and walls block; open doors pass', () => {
    const s = fixture();
    s.map.edges.push(
      {
        a: { x: 0, y: 0 },
        b: { x: 1, y: 0 },
        kind: 'door',
        state: 'closed',
      },
      {
        a: { x: 0, y: 0 },
        b: { x: 0, y: 1 },
        kind: 'wall',
      },
      {
        a: { x: 1, y: 0 },
        b: { x: 1, y: 1 },
        kind: 'wall',
      },
    );
    expect(path(s, 'a', { x: 1, y: 0 })).toMatchObject({ reason: 'occupied' });
    s.entities = [s.entities[0]!];
    expect(path(s, 'a', { x: 1, y: 0 })).toMatchObject({
      reason: 'unreachable',
    });
    s.map.edges[0]!.state = 'open';
    expect(path(s, 'a', { x: 1, y: 0 })).toMatchObject({
      path: [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
      ],
    });
  });
  test('occupied ending is rejected with reason occupied', () => {
    expect(canEndAt(fixture(), 'a', { x: 1, y: 0 })).toMatchObject({
      reason: 'occupied',
    });
  });
  test('all returned reachable cells have a route no more costly than remaining movement', () => {
    const s = fixture();
    const result = reachable(s, 'a');
    if (!Array.isArray(result)) throw new Error(result.error);
    for (const cell of result) {
      const route = path(s, 'a', cell.cell);
      expect('path' in route ? route.cost : Infinity).toBeLessThanOrEqual(
        s.resources!.a!.movementLeft!,
      );
    }
  });
});
