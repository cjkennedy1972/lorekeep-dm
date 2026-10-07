import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { loadAuthoredMap } from '../src/index.js';

const read = (n: string): unknown =>
  JSON.parse(
    readFileSync(new URL(`../maps/${n}.json`, import.meta.url), 'utf8'),
  );

describe.each(['crypt-room', 'forest-clearing'])('%s', (name) => {
  const r = loadAuthoredMap(read(name));
  test('loads and validates', () => {
    expect(r.ok).toBe(true);
  });
  test('has spawn zones and markers', () => {
    if (!r.ok) throw new Error('invalid');
    expect(
      r.map.zones.filter((z) => z.kind === 'spawn').length,
    ).toBeGreaterThan(0);
    expect(r.map.markers.length).toBeGreaterThan(0);
  });
  test('has a door, a cover feature and a difficult-terrain region', () => {
    if (!r.ok) throw new Error('invalid');
    const { map } = r;
    const cover = (c: { x: number; y: number }) =>
      map.palette[
        (function at() {
          let i = 0,
            pos = 0;
          for (; i < map.cells.length; i += 2) {
            pos += map.cells[i + 1]!;
            if (pos > c.y * map.w + c.x) return map.cells[i]!;
          }
          return 0;
        })()
      ]!;
    expect(map.edges.some((e) => e.kind === 'door')).toBe(true);
    expect(
      map.features.some(
        (f) =>
          f.tags.includes('cover') &&
          f.cells.every((c) => cover(c).cover !== 'none'),
      ),
    ).toBe(true);
    expect(
      map.features.some(
        (f) =>
          f.tags.includes('difficult') &&
          f.cells.every((c) => cover(c).moveCost > 1),
      ),
    ).toBe(true);
  });
});

describe('invalid input', () => {
  test('bad shape returns error list without throwing', () => {
    const r = loadAuthoredMap({ mapId: 'x' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.length).toBeGreaterThan(0);
  });
  test('non-object input returns errors', () => {
    expect(loadAuthoredMap(null).ok).toBe(false);
  });
  test('unknown terrain id is rejected', () => {
    const m = read('crypt-room') as { palette: { terrainId: string }[] };
    m.palette[0]!.terrainId = 'lava';
    const r = loadAuthoredMap(m);
    expect(r.ok).toBe(false);
  });
  test('duplicate feature id is rejected', () => {
    const m = read('crypt-room') as { features: { featureId: string }[] };
    m.features[1]!.featureId = m.features[0]!.featureId;
    expect(loadAuthoredMap(m).ok).toBe(false);
  });
});
