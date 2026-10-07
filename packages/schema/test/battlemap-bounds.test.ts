import { expect, test } from 'vitest';
import {
  BattlemapSchema,
  MAX_FEATURE_CELLS,
  MAX_MAP_CELLS,
  MAX_MAP_EDGES,
  MAX_MAP_FEATURES,
  MAX_MAP_MARKERS,
  MAX_MAP_ZONES,
} from '../src/index.js';

const cell = { x: 0, y: 0 };
const base = {
  mapId: 'm', w: 60, h: 60, palette: [{ terrainId: 'floor', moveCost: 1, blocksMove: false, blocksSight: false, cover: 'none', elevation: 0 }],
  cells: [0, 3600], edges: [], features: [], markers: [], zones: [],
};
const code = (input: unknown) => {
  const result = BattlemapSchema.safeParse(input);
  if (result.success) return 'none';
  return result.error.issues[0]?.message.split(':')[0];
};

test('accepts edge collection limits derived from 60x60 dimensions', () => {
  expect(BattlemapSchema.safeParse({ ...base, edges: Array.from({ length: MAX_MAP_EDGES }, () => ({ a: cell, b: { x: 1, y: 0 }, kind: 'wall' })) }).success).toBe(true);
});
test('rejects an oversized edge array with a specific error code', () => {
  expect(code({ ...base, edges: Array.from({ length: MAX_MAP_EDGES + 1 }, () => ({ a: cell, b: { x: 1, y: 0 }, kind: 'wall' })) })).toBe('EDGES_TOO_LARGE');
});
test('bounds features and their cell counts', () => {
  const feature = { featureId: 'f', kind: 'room', cells: [cell], tags: [] };
  expect(code({ ...base, features: Array.from({ length: MAX_MAP_FEATURES + 1 }, (_, i) => ({ ...feature, featureId: `f${i}` })) })).toBe('FEATURES_TOO_LARGE');
  expect(code({ ...base, features: [{ ...feature, cells: Array.from({ length: MAX_FEATURE_CELLS + 1 }, () => cell) }] })).toBe('FEATURE_CELLS_TOO_LARGE');
});
test('bounds marker and zone counts and zone cell counts', () => {
  expect(code({ ...base, markers: Array.from({ length: MAX_MAP_MARKERS + 1 }, (_, i) => ({ markerId: `m${i}`, cell, label: '' })) })).toBe('MARKERS_TOO_LARGE');
  const zone = { zoneId: 'z', kind: 'spawn', cells: [cell] };
  expect(code({ ...base, zones: Array.from({ length: MAX_MAP_ZONES + 1 }, (_, i) => ({ ...zone, zoneId: `z${i}` })) })).toBe('ZONES_TOO_LARGE');
  expect(code({ ...base, zones: [{ ...zone, cells: Array.from({ length: MAX_MAP_CELLS + 1 }, () => cell) }] })).toBe('ZONE_CELLS_TOO_LARGE');
});
