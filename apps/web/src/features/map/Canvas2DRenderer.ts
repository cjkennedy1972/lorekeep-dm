import { rleDecode, type Battlemap } from '@game/schema';
import type { MapDrawCommand, MapRenderer, MapView } from './MapRenderer.js';

/** Stable pattern identities keep terrain distinguishable without relying on hue. */
export function terrainPatternId(terrainId: string): string {
  const normalized = terrainId.trim().toLowerCase();
  if (!normalized) return 'terrain:unknown';
  return `terrain:${normalized.replace(/[^a-z0-9_-]+/g, '-')}`;
}

/** Builds a deterministic headless command list. Order is row-major, then map layer. */
export function createMapDrawCommands(map: Readonly<Battlemap>): readonly MapDrawCommand[] {
  const cells = rleDecode(map.cells);
  if (cells.length !== map.w * map.h) {
    throw new RangeError(`Map ${map.mapId} has ${cells.length} cells; expected ${map.w * map.h}`);
  }
  const commands: MapDrawCommand[] = [];
  for (let y = 0; y < map.h; y++) {
    for (let x = 0; x < map.w; x++) {
      const paletteIndex = cells[y * map.w + x]!;
      const terrain = map.palette[paletteIndex];
      if (!terrain) throw new RangeError(`Map ${map.mapId} has unknown palette index ${paletteIndex} at (${x},${y})`);
      commands.push({ type: 'terrain', x, y, terrainId: terrain.terrainId, patternId: terrainPatternId(terrain.terrainId), moveCost: terrain.moveCost, blocksMove: terrain.blocksMove });
      commands.push({ type: 'grid', x, y });
    }
  }
  for (const edge of map.edges) {
    const horizontal = edge.a.y === edge.b.y;
    commands.push({ type: 'edge', x: Math.min(edge.a.x, edge.b.x), y: Math.min(edge.a.y, edge.b.y), orientation: horizontal ? 'vertical' : 'horizontal', kind: edge.kind, ...(edge.state ? { state: edge.state } : {}) });
  }
  for (const feature of map.features) {
    for (const cell of feature.cells) commands.push({ type: 'feature', featureId: feature.featureId, kind: feature.kind, x: cell.x, y: cell.y, tags: [...feature.tags] });
  }
  for (const marker of map.markers) commands.push({ type: 'marker', markerId: marker.markerId, label: marker.label, x: marker.cell.x, y: marker.cell.y });
  return commands;
}

const TERRAIN_COLORS: Readonly<Record<string, string>> = {
  floor: '#d9d2c3', rubble: '#b8a98c', pillar: '#655f58', 'stone-wall': '#48433e',
};

/** Canvas2D renderer v1. The command generator is independent of browser APIs. */
export class Canvas2DRenderer implements MapRenderer {
  render(map: Readonly<Battlemap>, view?: Readonly<MapView>): readonly MapDrawCommand[] {
    void view;
    return createMapDrawCommands(map);
  }

  draw(context: CanvasRenderingContext2D, map: Readonly<Battlemap>, view: Readonly<MapView> = {}): readonly MapDrawCommand[] {
    const commands = this.render(map, view);
    const size = view.cellSize ?? 32;
    context.clearRect(0, 0, map.w * size, map.h * size);
    for (const command of commands) {
      const left = command.x * size;
      const top = command.y * size;
      switch (command.type) {
        case 'terrain': {
          context.fillStyle = TERRAIN_COLORS[command.terrainId] ?? '#c5c5c5';
          context.fillRect(left, top, size, size);
          // Pattern strokes encode terrain independently of its fill color.
          context.save();
          context.beginPath();
          context.rect(left, top, size, size);
          context.clip();
          context.strokeStyle = 'rgba(20, 20, 20, 0.42)';
          context.lineWidth = 1;
          if (command.patternId.endsWith('rubble')) {
            for (let offset = -size; offset < size * 2; offset += 8) {
              context.beginPath(); context.moveTo(left + offset, top); context.lineTo(left + offset + size, top + size); context.stroke();
            }
          } else if (command.patternId.endsWith('pillar') || command.patternId.endsWith('stone-wall')) {
            context.lineWidth = 2;
            context.strokeRect(left + 4, top + 4, size - 8, size - 8);
            if (command.patternId.endsWith('stone-wall')) {
              context.beginPath(); context.moveTo(left, top + size / 2); context.lineTo(left + size, top + size / 2); context.stroke();
            }
          }
          context.restore();
          break;
        }
        case 'grid':
          context.strokeStyle = 'rgba(35, 30, 25, 0.35)'; context.lineWidth = 1;
          context.strokeRect(left, top, size, size);
          break;
        case 'edge': {
          context.save();
          context.strokeStyle = command.kind === 'wall' ? '#28231f' : command.kind === 'door' ? '#8b4e20' : '#76a8b4';
          context.lineWidth = command.kind === 'wall' ? 4 : 3;
          const x = left + (command.orientation === 'vertical' ? size : size / 2);
          const y = top + (command.orientation === 'horizontal' ? size : size / 2);
          if (command.kind === 'window') context.setLineDash([3, 3]);
          if (command.kind === 'door' && command.state === 'open') context.setLineDash([2, 3]);
          context.beginPath();
          if (command.orientation === 'vertical') { context.moveTo(x, top); context.lineTo(x, top + size); }
          else { context.moveTo(left, y); context.lineTo(left + size, y); }
          context.stroke(); context.restore();
          break;
        }
        case 'feature':
          context.save(); context.strokeStyle = '#211d19'; context.lineWidth = 2;
          context.setLineDash(command.tags.includes('difficult') ? [2, 3] : []);
          context.strokeRect(left + 5, top + 5, size - 10, size - 10); context.restore();
          break;
        case 'marker':
          context.save(); context.fillStyle = '#fff8d6'; context.strokeStyle = '#302a22';
          context.beginPath(); context.arc(left + size / 2, top + size / 2, size * 0.18, 0, Math.PI * 2); context.fill(); context.stroke();
          context.font = `${Math.max(10, size * 0.35)}px sans-serif`; context.fillStyle = '#171411';
          context.fillText(command.label, left + size * 0.58, top + size * 0.35); context.restore();
          break;
      }
    }
    return commands;
  }
}
