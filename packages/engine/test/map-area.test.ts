import { describe, expect, test } from 'vitest';
import type { Battlemap, GridPos } from '@game/schema';
import {
  affectedEntities,
  areaCells,
  type AreaShape,
} from '../src/map/area.js';

const c = (x: number, y: number): GridPos => ({ x, y });
function makeMap(
  w: number,
  h: number,
  options: {
    walls?: [GridPos, GridPos][];
    blocked?: GridPos[];
    cover?: { cell: GridPos; value: 'half' | 'three-quarters' | 'full' }[];
  } = {},
): Battlemap {
  const blocked = new Set(
    (options.blocked ?? []).map(({ x, y }) => `${x},${y}`),
  );
  const coverAt = new Map(
    (options.cover ?? []).map(({ cell, value }) => [
      `${cell.x},${cell.y}`,
      value,
    ]),
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
      terrainId: 'wall',
      moveCost: 1,
      blocksMove: true,
      blocksSight: true,
      cover: 'full' as const,
      elevation: 0,
    },
  ];
  const cells: number[] = [];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const cover = coverAt.get(`${x},${y}`);
      const idx = blocked.has(`${x},${y}`) ? 1 : 0;
      // Cover grades get their own palette entries.
      if (cover) {
        let pi = palette.findIndex((p) => p.cover === cover);
        if (pi < 0) {
          pi = palette.length;
          palette.push({
            terrainId: `cover-${cover}`,
            moveCost: 1,
            blocksMove: false,
            blocksSight: false,
            cover,
            elevation: 0,
          });
        }
        cells.push(pi, 1);
      } else {
        const last = cells.length - 2;
        if (last >= 0 && cells[last] === idx) cells[last + 1]!++;
        else cells.push(idx, 1);
      }
    }
  return {
    mapId: 'area-test',
    w,
    h,
    palette,
    cells,
    edges: (options.walls ?? []).map(([a, b]) => ({
      a,
      b,
      kind: 'wall' as const,
    })),
    features: [],
    markers: [],
    zones: [],
    diagonalRule: '5ft',
  };
}
const cellKeys = (cells: GridPos[]) => cells.map(({ x, y }) => `${x},${y}`);
const count = (
  shape: AreaShape,
  size: number,
  direction = c(1, 0),
  origin = c(10, 10),
) => areaCells(makeMap(21, 21), { shape, size }, origin, direction).length;

describe('AoE template rasterization', () => {
  test.each([
    [5, 5],
    [10, 13],
    [15, 29],
    [20, 49],
    [25, 81],
  ])('sphere %i ft has documented cell count %i', (size, expected) => {
    expect(count('sphere', size)).toBe(expected);
  });
  test.each([
    [5, 1],
    [10, 4],
    [15, 9],
    [20, 16],
    [25, 25],
  ])('cube %i ft has documented cell count %i', (size, expected) => {
    expect(count('cube', size)).toBe(expected);
  });
  test.each([
    [5, 1],
    [10, 4],
    [15, 7],
    [20, 12],
    [25, 17],
  ])(
    'cone %i ft has SRD p.179 width-derived cell count %i',
    (size, expected) => {
      expect(count('cone', size)).toBe(expected);
    },
  );
  test('sphere spreads diagonally around a single blocked corner lane', () => {
    const map = makeMap(5, 5, { blocked: [c(2, 1)] });
    expect(
      cellKeys(areaCells(map, { shape: 'sphere', size: 15 }, c(1, 1))),
    ).toContain('2,2');
  });
  test('walls and sight-blocking terrain exclude cells beyond the obstruction', () => {
    const map = makeMap(6, 3, { walls: [[c(1, 1), c(2, 1)]] });
    expect(
      cellKeys(areaCells(map, { shape: 'line', size: 20 }, c(0, 1))),
    ).not.toContain('3,1');
    expect(
      cellKeys(
        areaCells(
          makeMap(6, 3, { blocked: [c(2, 1)] }),
          { shape: 'line', size: 20 },
          c(0, 1),
        ),
      ),
    ).not.toContain('3,1');
  });
  test('cone cell count is rotation-consistent in all eight directions', () => {
    const counts = [
      c(1, 0),
      c(1, 1),
      c(0, 1),
      c(-1, 1),
      c(-1, 0),
      c(-1, -1),
      c(0, -1),
      c(1, -1),
    ].map((d) => count('cone', 25, d));
    expect(counts).toEqual([17, 21, 17, 21, 17, 21, 17, 21]);
    expect(new Set(counts).size).toBe(2);
  });
  test('affectedEntities intersects large footprints once and reports cover bonus', () => {
    const map = makeMap(8, 4, { cover: [{ cell: c(5, 1), value: 'half' }] });
    const cells = [c(5, 1), c(6, 1)];
    const result = affectedEntities(
      cells,
      {
        map,
        entities: [
          { id: 'large', pos: c(5, 1), size: 2 },
          { id: 'outside', pos: c(0, 0), size: 1 },
        ],
      },
      c(1, 1),
    );
    expect(result).toEqual([{ id: 'large', saveBonus: 2 }]);
  });
  test('cube and sphere are stable sorted lists and origin is included', () => {
    const map = makeMap(10, 10);
    const sphere = areaCells(map, { shape: 'sphere', size: 10 }, c(4, 4));
    expect(sphere[0]).toEqual(c(4, 2));
    expect(sphere).toContainEqual(c(4, 4));
    expect(areaCells(map, { shape: 'cube', size: 10 }, c(4, 4))).toHaveLength(
      4,
    );
  });
});
