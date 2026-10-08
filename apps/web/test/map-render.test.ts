import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BattlemapSchema, rleEncode, type Battlemap } from '@game/schema';
import { describe, expect, it } from 'vitest';
import { Canvas2DRenderer, createMapDrawCommands, terrainPatternId } from '../src/features/map/Canvas2DRenderer.js';

const crypt = BattlemapSchema.parse(JSON.parse(readFileSync(resolve(process.cwd(), '../../packages/engine/maps/crypt-room.json'), 'utf8'))) as Battlemap;

describe('Canvas2DRenderer', () => {
  it('renders the crypt map to the stable headless snapshot', () => {
    const actual = createMapDrawCommands(crypt);
    expect(actual).toMatchSnapshot();
    expect(actual.some((command) => command.type === 'edge' && command.kind === 'door')).toBe(true);
    expect(actual.some((command) => command.type === 'feature')).toBe(true);
    expect(actual.some((command) => command.type === 'marker')).toBe(true);
  });

  it('assigns a distinct pattern identity to each terrain kind', () => {
    const patterns = crypt.palette.map((entry) => terrainPatternId(entry.terrainId));
    expect(new Set(patterns).size).toBe(crypt.palette.length);
  });

  it('creates the initial 60x60 headless draw list under the 100 ms guard', () => {
    const map = BattlemapSchema.parse({
      mapId: 'benchmark-60', w: 60, h: 60,
      palette: crypt.palette,
      cells: rleEncode(Array.from({ length: 3600 }, (_, i) => i % 4)),
      edges: [], features: [], markers: [], zones: [], diagonalRule: '5ft',
    }) as Battlemap;
    const started = performance.now();
    const commands = createMapDrawCommands(map);
    const elapsed = performance.now() - started;
    expect(commands).toHaveLength(7200);
    expect(elapsed).toBeLessThan(100);
  });

  it('is a pure renderer over readonly input', () => {
    const before = JSON.stringify(crypt);
    new Canvas2DRenderer().render(crypt);
    expect(JSON.stringify(crypt)).toBe(before);
  });
});
