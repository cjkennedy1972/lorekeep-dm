import { rleDecode, type Battlemap, type GridPos } from '@game/schema';
import { distance, type Placed } from './geometry.js';
import { coverBetween, type CoverGrade } from './cover.js';
import type { MovementEntity } from './reachable.js';
import { threatenedBy } from './threat.js';

export type DescribeVerbosity = 'brief' | 'standard' | 'full';
export type DescriptionEntity = MovementEntity & {
  name?: string;
  kind?: 'character' | 'monster' | 'npc';
  visibleTo?: readonly string[];
  hidden?: boolean;
  elevation?: number;
};
export interface DescribeState {
  map: Battlemap;
  entities: readonly DescriptionEntity[];
  activeEntityId?: string | null;
  resources?: Readonly<
    Record<string, { movementLeft?: number; movementRemaining?: number }>
  >;
  /** Explicit per-viewer visibility lists can be used when visibility is not on entities. */
  visibility?: Readonly<Record<string, readonly string[]>>;
}
export interface DescribeOptions {
  verbosity: DescribeVerbosity;
}

const label = (entity: DescriptionEntity) => entity.name ?? entity.id;
const coordOrder = (a: GridPos, b: GridPos) => a.y - b.y || a.x - b.x;
const decode = (map: Battlemap) => rleDecode(map.cells);

function direction(from: GridPos, to: GridPos): string {
  const dx = to.x - from.x,
    dy = to.y - from.y;
  if (!dx && !dy) return 'here';
  const vertical = dy < 0 ? 'north' : dy > 0 ? 'south' : '';
  const horizontal = dx < 0 ? 'west' : dx > 0 ? 'east' : '';
  return vertical && horizontal
    ? `${vertical}${horizontal}`
    : vertical || horizontal;
}
function nearestCell(from: Placed, to: Placed): GridPos {
  let best: GridPos | undefined;
  let bestDistance = Infinity;
  for (let y = 0; y < to.size; y++)
    for (let x = 0; x < to.size; x++) {
      const cell = { x: to.pos.x + x, y: to.pos.y + y };
      const d = Math.max(
        Math.abs(cell.x - from.pos.x),
        Math.abs(cell.y - from.pos.y),
      );
      if (
        d < bestDistance ||
        (d === bestDistance && best && coordOrder(cell, best) < 0)
      ) {
        best = cell;
        bestDistance = d;
      }
    }
  return best ?? to.pos;
}
function terrainDescription(
  map: Battlemap,
  entity: DescriptionEntity,
): string[] {
  const grid = decode(map),
    notes = new Set<string>();
  for (let y = 0; y < entity.size; y++)
    for (let x = 0; x < entity.size; x++) {
      const cell = { x: entity.pos.x + x, y: entity.pos.y + y };
      for (const feature of map.features)
        if (feature.cells.some((c) => c.x === cell.x && c.y === cell.y)) {
          const name = feature.kind.toLowerCase().replaceAll('-', ' ');
          if (feature.tags.some((tag) => tag.endsWith('-cover'))) {
            const grade = feature.tags.includes('three-quarters-cover')
              ? 'three-quarters'
              : feature.tags.includes('half-cover')
                ? 'half'
                : 'full';
            notes.add(
              `${name} (${grade === 'three-quarters' ? 'three-quarters' : grade} cover)`,
            );
          } else if (feature.tags.includes('difficult'))
            notes.add(`difficult ${name}`);
          else notes.add(name);
        }
      const terrain = map.palette[grid[cell.y * map.w + cell.x] ?? 0];
      if (terrain && terrain.moveCost > 1)
        notes.add(`difficult ${terrain.terrainId.replaceAll('-', ' ')}`);
    }
  return [...notes].sort();
}
function gradeText(grade: CoverGrade): string {
  return grade === 'none' || grade === 'full'
    ? ''
    : ` (${grade === 'three-quarters' ? 'three-quarters' : grade} cover)`;
}
function visibleEntities(
  state: DescribeState,
  viewerId: string,
): DescriptionEntity[] {
  const allowed = state.visibility?.[viewerId];
  return state.entities
    .filter(
      (entity) =>
        entity.id === viewerId ||
        (!entity.hidden &&
          entity.visibleTo?.includes(viewerId) !== false &&
          (!allowed || allowed.includes(entity.id))),
    )
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Deterministic battlefield text, filtered to entities visible to the viewer. */
export function describe(
  state: DescribeState,
  viewerId: string,
  options: DescribeOptions,
): string {
  const verbosity = options.verbosity;
  if (!['brief', 'standard', 'full'].includes(verbosity))
    throw new Error(`Unknown description verbosity: ${verbosity}`);
  const entities = visibleEntities(state, viewerId);
  const viewer = entities.find((entity) => entity.id === viewerId);
  if (!viewer) throw new Error(`Viewer ${viewerId} is not present on the map.`);
  const resources = state.resources?.[viewerId];
  const movement = resources?.movementLeft ?? resources?.movementRemaining;
  const prefix =
    verbosity === 'brief'
      ? []
      : [
          `You are at ${String.fromCharCode(65 + viewer.pos.x)}${viewer.pos.y + 1}.`,
        ];
  if (verbosity !== 'brief' && movement !== undefined)
    prefix.push(`${movement} ft movement remaining.`);
  const nearby = entities
    .filter((entity) => entity.id !== viewerId)
    .map((entity) => {
      const cell = nearestCell(viewer, entity);
      const feet = distance(viewer, entity, state.map.diagonalRule);
      const bearing = direction(viewer.pos, cell);
      const cover = coverBetween(state.map, viewer, entity).grade;
      const terrain =
        verbosity === 'full' ? terrainDescription(state.map, entity) : [];
      return {
        entity,
        text: `${label(entity)} is ${feet} ft ${bearing}${terrain.length ? ` among ${terrain.join(', ')}` : ''}${gradeText(cover)}.`,
      };
    });
  const ownTerrain =
    verbosity === 'full' ? terrainDescription(state.map, viewer) : [];
  if (ownTerrain.length) prefix.push(`You are on ${ownTerrain.join(', ')}.`);
  const lines = [...prefix, ...nearby.map((entry) => entry.text)];
  if (verbosity === 'full') {
    const hostiles = entities.filter((entity) => entity.team !== viewer.team);
    const threats = threatenedBy(
      viewer,
      hostiles,
      30,
      state.map.diagonalRule,
    ).filter((entity) => entities.some((visible) => visible.id === entity.id));
    lines.push(
      `Threats within 30 ft: ${threats.length ? threats.map(label).join(', ') : 'none'}.`,
    );
  }
  return lines.join(' ');
}

/** Return visible hostile creatures within 30 ft, in stable id order. */
export function threatsWithin(
  state: DescribeState,
  viewerId: string,
  feet = 30,
): string {
  const entities = visibleEntities(state, viewerId),
    viewer = entities.find((entity) => entity.id === viewerId);
  if (!viewer) throw new Error(`Viewer ${viewerId} is not present on the map.`);
  const threats = entities
    .filter(
      (entity) =>
        entity.id !== viewerId &&
        entity.team !== viewer.team &&
        distance(viewer, entity, state.map.diagonalRule) <= feet,
    )
    .sort((a, b) => a.id.localeCompare(b.id));
  return threats.length
    ? threats
        .map(
          (entity) =>
            `${label(entity)} (${distance(viewer, entity, state.map.diagonalRule)} ft ${direction(viewer.pos, nearestCell(viewer, entity))})`,
        )
        .join(', ')
    : 'No threats within 30 ft.';
}
