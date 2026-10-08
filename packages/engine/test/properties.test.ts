import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import {
  rleDecode,
  rleEncode,
  type Battlemap,
  type GridPos,
} from '@game/schema';
import { areaCells, type AreaShape } from '../src/map/area.js';
import { cellDistance } from '../src/map/geometry.js';
import { hasLineOfSight } from '../src/map/los.js';
import { path } from '../src/map/path.js';
import { reachable, type MovementState } from '../src/map/reachable.js';
import { nextDie, seedRng } from '../src/rng.js';

const pos = (x: number, y: number): GridPos => ({ x, y });
const palette = [
  {
    terrainId: 'floor',
    moveCost: 1,
    blocksMove: false,
    blocksSight: false,
    cover: 'none' as const,
    elevation: 0,
  },
];
function openMap(w: number, h: number): Battlemap {
  return {
    mapId: 'property',
    w,
    h,
    palette,
    cells: rleEncode(Array(w * h).fill(0)),
    edges: [],
    features: [],
    markers: [],
    zones: [],
    diagonalRule: '5ft',
  };
}
const mapArb = fc
  .integer({ min: 3, max: 10 })
  .chain((w) => fc.integer({ min: 3, max: 10 }).map((h) => openMap(w, h)));
const shapeArb = fc.constantFrom<AreaShape>(
  'sphere',
  'cube',
  'cone',
  'line',
  'cylinder',
);

describe('geometry properties (500 generated cases per property)', () => {
  test('path cost agrees with reachable cost for every affordable open-map goal', () =>
    fc.assert(
      fc.property(mapArb, fc.nat(), fc.nat(), (map, sx0, sy0) => {
        const start = pos(sx0 % map.w, sy0 % map.h);
        const state: MovementState = {
          map,
          entities: [{ id: 'a', pos: start, size: 1 }],
          resources: { a: { movementLeft: 60 } },
        };
        const cells = reachable(state, 'a');
        expect(Array.isArray(cells)).toBe(true);
        if (!Array.isArray(cells)) return;
        for (const reached of cells) {
          const found = path(state, 'a', reached.cell);
          expect('path' in found).toBe(true);
          if ('path' in found) expect(found.cost).toBe(reached.cost);
        }
      }),
      { numRuns: 500, seed: 2801 },
    ));

  test('line of sight is symmetric', () =>
    fc.assert(
      fc.property(
        mapArb,
        fc.nat(),
        fc.nat(),
        fc.nat(),
        fc.nat(),
        (map, ax, ay, bx, by) => {
          const a = { pos: pos(ax % map.w, ay % map.h), size: 1 },
            b = { pos: pos(bx % map.w, by % map.h), size: 1 };
          expect(hasLineOfSight(map, a, b)).toBe(hasLineOfSight(map, b, a));
        },
      ),
      { numRuns: 500, seed: 2802 },
    ));

  test('cell distance obeys metric laws under the 5ft rule', () =>
    fc.assert(
      fc.property(
        fc.tuple(
          fc.integer({ min: -50, max: 50 }),
          fc.integer({ min: -50, max: 50 }),
        ),
        fc.tuple(
          fc.integer({ min: -50, max: 50 }),
          fc.integer({ min: -50, max: 50 }),
        ),
        fc.tuple(
          fc.integer({ min: -50, max: 50 }),
          fc.integer({ min: -50, max: 50 }),
        ),
        (aa, bb, cc) => {
          const a = pos(...aa),
            b = pos(...bb),
            c = pos(...cc);
          expect(cellDistance(a, b)).toBe(cellDistance(b, a));
          expect(cellDistance(a, b)).toBe(
            5 * Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)),
          );
          expect(cellDistance(a, a)).toBe(0);
          expect(cellDistance(a, c)).toBeLessThanOrEqual(
            cellDistance(a, b) + cellDistance(b, c),
          );
        },
      ),
      { numRuns: 500, seed: 2803 },
    ));

  test('AoE shape counts are invariant under translation away from map edges', () =>
    fc.assert(
      fc.property(
        shapeArb,
        fc.integer({ min: 1, max: 5 }),
        fc.integer({ min: 0, max: 2 }),
        (shape, size, shift) => {
          const map = openMap(15, 15),
            template = { shape, size: size * 5 };
          const a = areaCells(map, template, pos(6, 6));
          const b = areaCells(map, template, pos(6 + shift, 6 + shift));
          expect(a.length).toBe(b.length);
        },
      ),
      { numRuns: 500, seed: 2804 },
    ));

  test('RLE encode/decode round-trips bounded grids', () =>
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 15 }), { maxLength: 3600 }),
        (grid) => {
          expect(rleDecode(rleEncode(grid))).toEqual(grid);
        },
      ),
      { numRuns: 500, seed: 2805 },
    ));

  test('seeded die replay is deterministic', () =>
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 0xffffffff }),
        fc.array(fc.integer({ min: 2, max: 100 }), {
          minLength: 1,
          maxLength: 100,
        }),
        (seed, sides) => {
          const rollAll = () => {
            let state = seedRng(seed);
            return sides.map((die) => {
              const [value, next] = nextDie(state, die);
              state = next;
              return value;
            });
          };
          expect(rollAll()).toEqual(rollAll());
        },
      ),
      { numRuns: 500, seed: 2806 },
    ));
});
