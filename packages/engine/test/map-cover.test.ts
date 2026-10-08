import { describe, expect, test } from 'vitest';
import type { Battlemap, Cell } from '@game/schema';
import { coverBetween } from '../src/map/cover.js';

const c = (x: number, y: number): Cell => ({ x, y });
function makeMap(
  w: number,
  h: number,
  coverCells: Cell[] = [],
  features: Battlemap['features'] = [],
  walls: [Cell, Cell][] = [],
): Battlemap {
  const indices = new Set(coverCells.map((p) => `${p.x},${p.y}`));
  const grid = Array.from({ length: w * h }, (_, i) =>
    indices.has(`${i % w},${Math.floor(i / w)}`) ? 1 : 0,
  );
  const cells: number[] = [];
  for (const i of grid) {
    if (cells.length && cells[cells.length - 2] === i)
      cells[cells.length - 1]!++;
    else cells.push(i, 1);
  }
  return {
    mapId: 'cover-test',
    w,
    h,
    palette: [
      {
        terrainId: 'floor',
        moveCost: 1,
        blocksMove: false,
        blocksSight: false,
        cover: 'none',
        elevation: 0,
      },
      {
        terrainId: 'pillar',
        moveCost: 1,
        blocksMove: true,
        blocksSight: true,
        cover: 'half',
        elevation: 0,
      },
    ],
    cells,
    features,
    edges: walls.map(([a, b]) => ({ a, b, kind: 'wall' as const })),
    markers: [],
    zones: [],
    diagonalRule: '5ft',
  };
}
const placed = (x: number, y: number, size = 1) => ({ pos: c(x, y), size });

describe('coverBetween', () => {
  test('pillar between attacker and target grants half cover', () => {
    const result = coverBetween(
      makeMap(3, 1, [c(1, 0)]),
      placed(0, 0),
      placed(2, 0),
    );
    expect(result.grade).toBe('half');
    expect(result.acBonus).toBe(2);
    expect(result.targetable).toBe(true);
  });
  test('full cover makes target untargetable with no line reason', () => {
    const map = makeMap(3, 1);
    map.palette[0]!.cover = 'full';
    const result = coverBetween(map, placed(0, 0), placed(2, 0));
    expect(result).toMatchObject({
      grade: 'full',
      targetable: false,
      error: 'no line',
    });
  });
  test('display uses the exact half-cover wording', () => {
    expect(
      coverBetween(makeMap(3, 1, [c(1, 0)]), placed(0, 0), placed(2, 0))
        .display,
    ).toBe('cover: half (+2 AC)');
  });
  test('more blocked lines never reduce the cover grade', () => {
    const levels = ['none', 'half', 'three-quarters', 'full'] as const;
    let previous = -1;
    for (let blocked = 0; blocked <= 4; blocked++) {
      const map = makeMap(
        6,
        3,
        Array.from({ length: blocked }, (_, i) => c(1 + i, 1)),
      );
      const result = coverBetween(map, placed(0, 1, 2), placed(5, 1, 2));
      const current = levels.indexOf(result.grade);
      expect(current).toBeGreaterThanOrEqual(previous);
      previous = current;
    }
  });
  test('feature cover tags contribute cover', () => {
    const features: Battlemap['features'] = [
      {
        featureId: 'barrel',
        kind: 'object',
        cells: [c(1, 0)],
        tags: ['half-cover'],
      },
    ];
    expect(
      coverBetween(makeMap(3, 1, [], features), placed(0, 0), placed(2, 0))
        .grade,
    ).toBe('half');
  });
});
