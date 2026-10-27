import { rleDecode, type Battlemap } from '@game/schema';
import type { MapDrawCommand, MapRenderer, MapView } from './MapRenderer.js';
import type { TeamMarker, TokenDrawCommand } from './tokens.js';
import { initialsOf } from './names.js';

/** Stable pattern identities keep terrain distinguishable without relying on hue. */
export function terrainPatternId(terrainId: string): string {
  const normalized = terrainId.trim().toLowerCase();
  if (!normalized) return 'terrain:unknown';
  return `terrain:${normalized.replace(/[^a-z0-9_-]+/g, '-')}`;
}

/** Builds a deterministic headless command list. Order is row-major, then map layer. */
export function createMapDrawCommands(
  map: Readonly<Battlemap>,
): readonly MapDrawCommand[] {
  const cells = rleDecode(map.cells);
  if (cells.length !== map.w * map.h) {
    throw new RangeError(
      `Map ${map.mapId} has ${cells.length} cells; expected ${map.w * map.h}`,
    );
  }
  const commands: MapDrawCommand[] = [];
  for (let y = 0; y < map.h; y++) {
    for (let x = 0; x < map.w; x++) {
      const paletteIndex = cells[y * map.w + x]!;
      const terrain = map.palette[paletteIndex];
      if (!terrain)
        throw new RangeError(
          `Map ${map.mapId} has unknown palette index ${paletteIndex} at (${x},${y})`,
        );
      commands.push({
        type: 'terrain',
        x,
        y,
        terrainId: terrain.terrainId,
        patternId: terrainPatternId(terrain.terrainId),
        moveCost: terrain.moveCost,
        blocksMove: terrain.blocksMove,
      });
      commands.push({ type: 'grid', x, y });
    }
  }
  for (const edge of map.edges) {
    const horizontal = edge.a.y === edge.b.y;
    commands.push({
      type: 'edge',
      x: Math.min(edge.a.x, edge.b.x),
      y: Math.min(edge.a.y, edge.b.y),
      orientation: horizontal ? 'vertical' : 'horizontal',
      kind: edge.kind,
      ...(edge.state ? { state: edge.state } : {}),
    });
  }
  for (const feature of map.features) {
    for (const cell of feature.cells)
      commands.push({
        type: 'feature',
        featureId: feature.featureId,
        kind: feature.kind,
        x: cell.x,
        y: cell.y,
        tags: [...feature.tags],
      });
  }
  for (const marker of map.markers)
    commands.push({
      type: 'marker',
      markerId: marker.markerId,
      label: marker.label,
      x: marker.cell.x,
      y: marker.cell.y,
    });
  return commands;
}

/**
 * Dark parchment-and-ink palette for the lantern-lit UI. Hex only: src/a11y/contrast.test.ts parses
 * this block and checks every drawn element against the floor. Terrain stays distinguishable by
 * pattern as well as fill, and teams by shape as well as hue.
 */
export const MAP_PALETTE = {
  floor: '#3b3328',
  rubble: '#54472f',
  pillar: '#8c8171',
  wall: '#1a1612',
  fallback: '#463d30',
  /** Pattern and grid strokes are this ink drawn at the alpha below. */
  patternInk: '#f1e7d3',
  patternAlpha: 0.5,
  gridInk: '#f1e7d3',
  gridAlpha: 0.1,
  edgeWall: '#f1e7d3',
  edgeDoor: '#f0a64a',
  edgeWindow: '#7fd0e0',
  feature: '#d9c9a3',
  markerFill: '#f0a64a',
  markerStroke: '#14110f',
  markerText: '#f7ecd4',
  tokenParty: '#8fd6c4',
  tokenFoe: '#ffa393',
  tokenOther: '#f1e7d3',
  tokenInk: '#14110f',
  activeRing: '#ffd37a',
  activeRingOuter: '#fff1c9',
  cursor: '#7fd0e0',
} as const;

const TERRAIN_COLORS: Readonly<Record<string, string>> = {
  floor: MAP_PALETTE.floor,
  rubble: MAP_PALETTE.rubble,
  pillar: MAP_PALETTE.pillar,
  'stone-wall': MAP_PALETTE.wall,
};
const withAlpha = (hex: string, alpha: number) => {
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
};

/** Canvas2D renderer v1. The command generator is independent of browser APIs. */
export class Canvas2DRenderer implements MapRenderer {
  render(
    map: Readonly<Battlemap>,
    view?: Readonly<MapView>,
  ): readonly MapDrawCommand[] {
    void view;
    return createMapDrawCommands(map);
  }

  /** Tokens come from the same tracker-ordered list as the initiative tracker, so the active ring always matches the first entry. */
  draw(
    context: CanvasRenderingContext2D,
    map: Readonly<Battlemap>,
    view: Readonly<MapView> = {},
    tokens: readonly TokenDrawCommand[] = [],
  ): readonly MapDrawCommand[] {
    const commands = this.render(map, view);
    const size = view.cellSize ?? 32;
    context.clearRect(0, 0, map.w * size, map.h * size);
    for (const command of commands) {
      const left = command.x * size;
      const top = command.y * size;
      switch (command.type) {
        case 'terrain': {
          context.fillStyle =
            TERRAIN_COLORS[command.terrainId] ?? MAP_PALETTE.fallback;
          context.fillRect(left, top, size, size);
          // Pattern strokes encode terrain independently of its fill color.
          context.save();
          context.beginPath();
          context.rect(left, top, size, size);
          context.clip();
          context.strokeStyle = withAlpha(
            MAP_PALETTE.patternInk,
            MAP_PALETTE.patternAlpha,
          );
          context.lineWidth = 1;
          if (command.patternId.endsWith('rubble')) {
            for (let offset = -size; offset < size * 2; offset += 8) {
              context.beginPath();
              context.moveTo(left + offset, top);
              context.lineTo(left + offset + size, top + size);
              context.stroke();
            }
          } else if (
            command.patternId.endsWith('pillar') ||
            command.patternId.endsWith('stone-wall')
          ) {
            context.lineWidth = 2;
            context.strokeRect(left + 4, top + 4, size - 8, size - 8);
            if (command.patternId.endsWith('stone-wall')) {
              context.beginPath();
              context.moveTo(left, top + size / 2);
              context.lineTo(left + size, top + size / 2);
              context.stroke();
            }
          }
          context.restore();
          break;
        }
        case 'grid':
          context.strokeStyle = withAlpha(
            MAP_PALETTE.gridInk,
            MAP_PALETTE.gridAlpha,
          );
          context.lineWidth = 1;
          context.strokeRect(left, top, size, size);
          break;
        case 'edge': {
          context.save();
          context.strokeStyle =
            command.kind === 'wall'
              ? MAP_PALETTE.edgeWall
              : command.kind === 'door'
                ? MAP_PALETTE.edgeDoor
                : MAP_PALETTE.edgeWindow;
          context.lineWidth = command.kind === 'wall' ? 4 : 3;
          const x =
            left + (command.orientation === 'vertical' ? size : size / 2);
          const y =
            top + (command.orientation === 'horizontal' ? size : size / 2);
          if (command.kind === 'window') context.setLineDash([3, 3]);
          if (command.kind === 'door' && command.state === 'open')
            context.setLineDash([2, 3]);
          context.beginPath();
          if (command.orientation === 'vertical') {
            context.moveTo(x, top);
            context.lineTo(x, top + size);
          } else {
            context.moveTo(left, y);
            context.lineTo(left + size, y);
          }
          context.stroke();
          context.restore();
          break;
        }
        case 'feature':
          context.save();
          context.strokeStyle = MAP_PALETTE.feature;
          context.lineWidth = 2;
          context.setLineDash(command.tags.includes('difficult') ? [2, 3] : []);
          context.strokeRect(left + 5, top + 5, size - 10, size - 10);
          context.restore();
          break;
        case 'marker':
          context.save();
          context.fillStyle = MAP_PALETTE.markerFill;
          context.strokeStyle = MAP_PALETTE.markerStroke;
          context.beginPath();
          context.arc(
            left + size / 2,
            top + size / 2,
            size * 0.18,
            0,
            Math.PI * 2,
          );
          context.fill();
          context.stroke();
          context.font = `${Math.max(10, size * 0.35)}px sans-serif`;
          // Dark halo keeps the label legible over any terrain.
          context.lineWidth = 3;
          context.lineJoin = 'round';
          context.strokeStyle = MAP_PALETTE.markerStroke;
          context.strokeText(
            command.label,
            left + size * 0.58,
            top + size * 0.35,
          );
          context.fillStyle = MAP_PALETTE.markerText;
          context.fillText(
            command.label,
            left + size * 0.58,
            top + size * 0.35,
          );
          context.restore();
          break;
      }
    }
    for (const token of tokens) drawToken(context, token, size);
    if (view.cursor)
      drawCursor(context, view.cursor, size, view.moving === true);
    return commands;
  }
}

/** Draws a combatant as a team shape with the name's initials; the active ring is a double stroke, not a color cue. */
function drawToken(
  context: CanvasRenderingContext2D,
  token: TokenDrawCommand,
  size: number,
): void {
  const span = size * token.footprint;
  const cx = token.x * size + span / 2;
  const cy = token.y * size + span / 2;
  const radius = span * 0.36;
  context.save();
  if (token.active) {
    context.strokeStyle = MAP_PALETTE.activeRing;
    context.lineWidth = 3;
    context.beginPath();
    context.arc(cx, cy, radius + 5, 0, Math.PI * 2);
    context.stroke();
    context.strokeStyle = MAP_PALETTE.activeRingOuter;
    context.setLineDash([3, 3]);
    context.beginPath();
    context.arc(cx, cy, radius + 9, 0, Math.PI * 2);
    context.stroke();
    context.setLineDash([]);
  }
  context.fillStyle =
    token.team === 'party'
      ? MAP_PALETTE.tokenParty
      : token.team === 'monster' || token.team === 'enemies'
        ? MAP_PALETTE.tokenFoe
        : MAP_PALETTE.tokenOther;
  context.strokeStyle = MAP_PALETTE.tokenInk;
  context.lineWidth = 2;
  drawShape(context, token.teamMarker.shape, cx, cy, radius);
  context.fill();
  context.stroke();
  const initials = initialsOf(token.name);
  context.fillStyle = MAP_PALETTE.tokenInk;
  context.font = `bold ${Math.max(10, radius * (initials.length > 1 ? 0.95 : 1.1))}px sans-serif`;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(initials, cx, cy);
  context.restore();
}

/** Cursor cell: corner brackets plus a dashed frame while a move is being previewed. */
function drawCursor(
  context: CanvasRenderingContext2D,
  cell: { x: number; y: number },
  size: number,
  moving: boolean,
): void {
  const left = cell.x * size;
  const top = cell.y * size;
  const arm = size * 0.3;
  context.save();
  context.strokeStyle = MAP_PALETTE.cursor;
  context.lineWidth = 3;
  if (moving) {
    context.setLineDash([4, 3]);
    context.strokeRect(left + 1.5, top + 1.5, size - 3, size - 3);
    context.setLineDash([]);
  }
  for (const [px, py, dx, dy] of [
    [left + 1.5, top + 1.5, 1, 1],
    [left + size - 1.5, top + 1.5, -1, 1],
    [left + 1.5, top + size - 1.5, 1, -1],
    [left + size - 1.5, top + size - 1.5, -1, -1],
  ] as const) {
    context.beginPath();
    context.moveTo(px + dx * arm, py);
    context.lineTo(px, py);
    context.lineTo(px, py + dy * arm);
    context.stroke();
  }
  context.restore();
}

function drawShape(
  context: CanvasRenderingContext2D,
  shape: TeamMarker['shape'],
  cx: number,
  cy: number,
  r: number,
): void {
  context.beginPath();
  if (shape === 'circle') {
    context.arc(cx, cy, r, 0, Math.PI * 2);
    return;
  }
  if (shape === 'square') {
    context.rect(cx - r, cy - r, r * 2, r * 2);
    return;
  }
  const sides =
    shape === 'triangle'
      ? 3
      : shape === 'diamond'
        ? 4
        : shape === 'hexagon'
          ? 6
          : 5;
  const rotation = shape === 'diamond' ? 0 : -Math.PI / 2;
  for (let i = 0; i < sides; i++) {
    const angle = rotation + (i * Math.PI * 2) / sides;
    const px = cx + Math.cos(angle) * r;
    const py = cy + Math.sin(angle) * r;
    if (i === 0) context.moveTo(px, py);
    else context.lineTo(px, py);
  }
  context.closePath();
}
