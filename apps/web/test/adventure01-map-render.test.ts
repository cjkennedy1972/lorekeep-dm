import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import adventure from '../../../packages/engine/adventures/01/adventure.json' with { type: 'json' };
import { Canvas2DRenderer } from '../src/features/map/Canvas2DRenderer.js';
import { BattlemapSchema } from '@game/schema';

describe('Adventure #1 maps render', () => {
  test.each(adventure.maps.map((map) => [map.mapId, map.mapId] as const))(
    '%s renders terrain, features, edges and markers',
    (_label, mapId) => {
      const raw = JSON.parse(
        readFileSync(
          resolve(process.cwd(), `../../packages/engine/maps/${mapId}.json`),
          'utf8',
        ),
      ) as unknown;
      const parsed = BattlemapSchema.safeParse(raw);
      expect(parsed.success).toBe(true);
      if (!parsed.success) return;
      const commands = new Canvas2DRenderer().render(parsed.data);
      expect(commands.length).toBeGreaterThan(parsed.data.w * parsed.data.h);
      expect(commands.some((command) => command.type === 'feature')).toBe(true);
      expect(commands.some((command) => command.type === 'marker')).toBe(true);
    },
  );
});
