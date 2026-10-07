import { rleEncode, type Battlemap } from '@game/schema';
import { describe, expect, test } from 'vitest';
import { validateBattlemap } from '../src/index.js';

const floor = {
  terrainId: 'floor',
  moveCost: 1,
  blocksMove: false,
  blocksSight: false,
  cover: 'none',
  elevation: 0,
};
const rock = {
  ...floor,
  terrainId: 'rock',
  blocksMove: true,
  blocksSight: true,
  cover: 'full',
};

function fixture(w = 60, h = 60): Battlemap {
  const grid: number[] = [];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      grid.push(x === 0 || y === 0 || x === w - 1 || y === h - 1 ? 1 : 0);
  return {
    mapId: 'm1',
    w,
    h,
    palette: [floor, rock],
    cells: rleEncode(grid),
    edges: [
      { a: { x: 5, y: 5 }, b: { x: 6, y: 5 }, kind: 'door', state: 'closed' },
    ],
    features: [
      {
        featureId: 'feat_pillar1',
        kind: 'pillar',
        cells: [{ x: 10, y: 10 }],
        tags: [],
      },
    ],
    markers: [{ markerId: 'mk_altar', cell: { x: 20, y: 20 }, label: 'Altar' }],
    zones: [
      {
        zoneId: 'z1',
        kind: 'spawn',
        cells: [{ x: 2, y: 2 }],
        anchorMarkerId: 'mk_altar',
      },
    ],
    diagonalRule: '5ft',
  } as Battlemap;
}

const codes = (m: unknown) => {
  const r = validateBattlemap(m);
  return r.ok ? [] : r.errors.map((e) => e.code);
};

describe('validateBattlemap', () => {
  test('typical 60x60 fixture is valid and RLE JSON < 20 KB', () => {
    expect(validateBattlemap(fixture()).ok).toBe(true);
    expect(JSON.stringify(fixture()).length).toBeLessThan(20_000);
  });
  test('61x61 rejected', () => {
    expect(codes(fixture(61, 61))).toContain('SCHEMA_INVALID');
  });
  test('dimension mismatch', () => {
    expect(codes({ ...fixture(), w: 59 })).toContain('DIMENSION_MISMATCH');
  });
  test('huge run returns an error instead of throwing', () => {
    expect(codes({ ...fixture(), cells: [0, 200_000_000] })).toContain(
      'DIMENSION_MISMATCH',
    );
  });
  test('zero-length run and odd length', () => {
    expect(codes({ ...fixture(), cells: [0, 0, 0, 3600] })).toContain(
      'BAD_RLE_RUN',
    );
    expect(codes({ ...fixture(), cells: [0, 3600, 0] })).toContain(
      'DIMENSION_MISMATCH',
    );
  });
  test('bad palette index', () => {
    expect(codes({ ...fixture(), cells: [7, 3600] })).toContain(
      'BAD_PALETTE_INDEX',
    );
  });
  test('unknown id', () => {
    const m = fixture();
    m.zones[0]!.anchorMarkerId = 'mk_nope';
    expect(codes(m)).toContain('UNKNOWN_ID');
  });
  test('door on non-edge', () => {
    const m = fixture();
    m.edges[0]!.b = { x: 9, y: 9 };
    expect(codes(m)).toContain('DOOR_NOT_ON_EDGE');
  });
  test('door out of bounds', () => {
    const m = fixture();
    m.edges[0]!.b = { x: 60, y: 5 };
    expect(codes(m)).toContain('EDGE_OUT_OF_BOUNDS');
  });
});
