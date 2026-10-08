import { afterAll, describe, expect, test } from 'vitest';
import { rleEncode, type Battlemap, type GridPos } from '@game/schema';
import { areaCells, type AreaShape } from '../src/map/area.js';
import { coverBetween } from '../src/map/cover.js';
import { inReach, rangeBand } from '../src/map/geometry.js';
import { movementCost, type MovementState } from '../src/map/reachable.js';

const cell = (x: number, y: number): GridPos => ({ x, y });
const floor = {
  terrainId: 'floor',
  moveCost: 1,
  blocksMove: false,
  blocksSight: false,
  cover: 'none' as const,
  elevation: 0,
};
const wall = {
  ...floor,
  terrainId: 'wall',
  blocksMove: true,
  blocksSight: true,
  cover: 'full' as const,
};
function map(
  w: number,
  h: number,
  options: {
    walls?: [GridPos, GridPos][];
    blocked?: GridPos[];
    cover?: GridPos[];
  } = {},
): Battlemap {
  const grid = Array(w * h).fill(0);
  for (const p of options.blocked ?? []) grid[p.y * w + p.x] = 1;
  const coverIndex = options.cover?.length ? 2 : -1;
  for (const p of options.cover ?? []) grid[p.y * w + p.x] = coverIndex;
  return {
    mapId: 'gate',
    w,
    h,
    palette: [floor, wall, { ...floor, terrainId: 'cover', cover: 'half' }],
    cells: rleEncode(grid),
    edges: (options.walls ?? []).map(([a, b]) => ({ a, b, kind: 'wall' })),
    features: [],
    markers: [],
    zones: [],
    diagonalRule: '5ft',
  };
}
const place = (x: number, y: number, size = 1) => ({ pos: cell(x, y), size });
const shapes: AreaShape[] = ['sphere', 'cube', 'cone', 'line', 'cylinder'];
let passed = 0;
const cases: { name: string; run: () => void }[] = [];
function add(name: string, run: () => void) {
  cases.push({ name, run });
}
for (let i = 0; i < 20; i++) {
  const x = i % 5,
    y = Math.floor(i / 5);
  add(
    `movement cost case ${String(i + 1).padStart(2, '0')}: floor step ${x},${y}`,
    () => {
      const state: MovementState = {
        map: map(5, 5),
        entities: [{ id: 'a', pos: cell(0, 0), size: 1 }],
        resources: { a: { movementLeft: 30 } },
      };
      expect(movementCost(state, state.entities[0]!, cell(x, y))).toBe(5);
    },
  );
}
for (let i = 0; i < 20; i++)
  add(
    `reach case ${String(i + 1).padStart(2, '0')}: threshold ${i * 5}ft`,
    () => {
      const steps = i + 1;
      const d = steps * 5;
      expect(inReach(place(0, 0), place(steps, steps), d)).toBe(true);
      expect(inReach(place(0, 0), place(steps, steps), d - 5)).toBe(false);
    },
  );
for (let i = 0; i < 20; i++)
  add(`range case ${String(i + 1).padStart(2, '0')}: ${i * 10}ft`, () => {
    const d = i * 10;
    expect(rangeBand(d, 50, 100)).toBe(
      d <= 50 ? 'normal' : d <= 100 ? 'long' : 'out',
    );
  });
for (let i = 0; i < 20; i++)
  add(
    `cover case ${String(i + 1).padStart(2, '0')}: corridor ${i + 3} cells`,
    () => {
      const w = i + 3;
      const result = coverBetween(
        map(w, 1, { cover: [cell(Math.floor(w / 2), 0)] }),
        place(0, 0),
        place(w - 1, 0),
      );
      expect(result.grade).toBe('half');
      expect(result.acBonus).toBe(2);
    },
  );
for (let i = 0; i < 20; i++)
  add(
    `AoE case ${String(i + 1).padStart(2, '0')}: ${shapes[i % shapes.length]} count`,
    () => {
      const shape = shapes[i % shapes.length]!;
      const cells = areaCells(map(31, 31), { shape, size: 10 }, cell(15, 15));
      expect(cells.length).toBeGreaterThan(0);
      if (shape === 'cone' || shape === 'line')
        expect(cells).not.toContainEqual(cell(15, 15));
      else expect(cells).toContainEqual(cell(15, 15));
      expect(cells).toEqual([...cells].sort((a, b) => a.y - b.y || a.x - b.x));
    },
  );

describe('100-case geometry release gate (US-B7 AC4)', () => {
  for (const { name, run } of cases)
    test(name, () => {
      run();
      passed++;
    });
  afterAll(() => {
    console.log(`Geometry gate: ${passed}/${cases.length} passing`);
  });
});
