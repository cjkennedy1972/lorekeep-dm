import { describe, expect, test } from 'vitest';
import type { Battlemap, Cell } from '@game/schema';
import { hasLineOfSight } from '../src/map/los.js';

function makeMap(
  w: number,
  h: number,
  options: {
    walls?: [Cell, Cell][];
    windows?: [Cell, Cell][];
    closedDoors?: [Cell, Cell][];
    blocked?: Cell[];
  } = {},
): Battlemap {
  const blocked = new Set(
    (options.blocked ?? []).map(({ x, y }) => `${x},${y}`),
  );
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
      terrainId: 'stone',
      moveCost: 1,
      blocksMove: false,
      blocksSight: true,
      cover: 'full' as const,
      elevation: 0,
    },
  ];
  const cells: number[] = [];
  for (let i = 0; i < w * h; i++) {
    const idx = blocked.has(`${i % w},${Math.floor(i / w)}`) ? 1 : 0;
    const last = cells.length - 2;
    if (last >= 0 && cells[last] === idx) cells[last + 1]!++;
    else cells.push(idx, 1);
  }
  const edges = [
    ...(options.walls ?? []).map(([a, b]) => ({ a, b, kind: 'wall' as const })),
    ...(options.windows ?? []).map(([a, b]) => ({
      a,
      b,
      kind: 'window' as const,
    })),
    ...(options.closedDoors ?? []).map(([a, b]) => ({
      a,
      b,
      kind: 'door' as const,
      state: 'closed' as const,
    })),
  ];
  return {
    mapId: 'test',
    w,
    h,
    palette,
    cells,
    edges,
    features: [],
    markers: [],
    zones: [],
    diagonalRule: '5ft',
  };
}

const cell = (x: number, y: number) => ({ x, y });
const creature = (x: number, y: number, size = 1) => ({
  pos: cell(x, y),
  size,
});

describe('hasLineOfSight', () => {
  test('open adjacent cells see each other', () =>
    expect(hasLineOfSight(makeMap(2, 1), creature(0, 0), creature(1, 0))).toBe(
      true,
    ));
  test('same cell has line of sight', () =>
    expect(hasLineOfSight(makeMap(1, 1), creature(0, 0), creature(0, 0))).toBe(
      true,
    ));
  test('wall between two cells blocks', () =>
    expect(
      hasLineOfSight(
        makeMap(2, 1, { walls: [[cell(0, 0), cell(1, 0)]] }),
        creature(0, 0),
        creature(1, 0),
      ),
    ).toBe(false));
  test('window edge does not block', () =>
    expect(
      hasLineOfSight(
        makeMap(2, 1, { windows: [[cell(0, 0), cell(1, 0)]] }),
        creature(0, 0),
        creature(1, 0),
      ),
    ).toBe(true));
  test('closed door blocks', () =>
    expect(
      hasLineOfSight(
        makeMap(2, 1, { closedDoors: [[cell(0, 0), cell(1, 0)]] }),
        creature(0, 0),
        creature(1, 0),
      ),
    ).toBe(false));
  test('intermediate blocksSight cell blocks', () =>
    expect(
      hasLineOfSight(
        makeMap(3, 1, { blocked: [cell(1, 0)] }),
        creature(0, 0),
        creature(2, 0),
      ),
    ).toBe(false));
  test('endpoint terrain does not block its occupant sight', () =>
    expect(
      hasLineOfSight(
        makeMap(2, 1, { blocked: [cell(0, 0)] }),
        creature(0, 0),
        creature(1, 0),
      ),
    ).toBe(true));
  test('open door transmits sight', () => {
    const map = makeMap(2, 1);
    map.edges.push({
      a: cell(0, 0),
      b: cell(1, 0),
      kind: 'door',
      state: 'open',
    });
    expect(hasLineOfSight(map, creature(0, 0), creature(1, 0))).toBe(true);
  });
  test('unobstructed diagonal sees across the corner', () =>
    expect(hasLineOfSight(makeMap(2, 2), creature(0, 0), creature(1, 1))).toBe(
      true,
    ));
  test('corner ray succeeds when one lane is clear', () =>
    expect(
      hasLineOfSight(
        makeMap(2, 2, { blocked: [cell(1, 0)] }),
        creature(0, 0),
        creature(1, 1),
      ),
    ).toBe(true));
  test('corner ray blocks when both lanes obstructed', () =>
    expect(
      hasLineOfSight(
        makeMap(2, 2, { blocked: [cell(1, 0), cell(0, 1)] }),
        creature(0, 0),
        creature(1, 1),
      ),
    ).toBe(false));
  test('large footprint can see from any clear cell pair', () =>
    expect(
      hasLineOfSight(
        makeMap(4, 2, { blocked: [cell(2, 0)] }),
        creature(0, 0, 2),
        creature(3, 0),
      ),
    ).toBe(true));
  test('blocksight terrain in the direct corridor blocks sight', () =>
    expect(
      hasLineOfSight(
        makeMap(5, 1, { blocked: [cell(2, 0)] }),
        creature(0, 0),
        creature(4, 0),
      ),
    ).toBe(false));
  test('LOS is symmetric for 1000 seeded random pairs', () => {
    let seed = 20;
    const random = (limit: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % limit;
    };
    const map = makeMap(12, 12, {
      blocked: Array.from({ length: 25 }, () => cell(random(12), random(12))),
    });
    for (let i = 0; i < 1000; i++) {
      const a = creature(random(12), random(12), 1 + random(2));
      const b = creature(random(12), random(12), 1 + random(2));
      expect(hasLineOfSight(map, a, b), `case ${i}`).toBe(
        hasLineOfSight(map, b, a),
      );
    }
  });
  test('distant clear cells remain visible', () =>
    expect(hasLineOfSight(makeMap(8, 8), creature(0, 0), creature(7, 7))).toBe(
      true,
    ));
});
