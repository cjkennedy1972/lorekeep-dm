import { AdventureSchema, type Adventure } from '@game/schema';
import type { Catalog } from '../catalog/types.js';
export const ADVENTURE_MAX_MONSTER_CR = 5;
import { loadAuthoredMap } from '../map/load.js';
export { nextSceneAfterClose } from './transition.js';
import { rleDecode, type Battlemap } from '@game/schema';
import denylistData from './denylist.js';

export type AdventureErrorCode =
  | 'SCHEMA_INVALID'
  | 'DANGLING_SCENE_REF'
  | 'DANGLING_ENCOUNTER_REF'
  | 'DANGLING_MAP_REF'
  | 'DANGLING_MONSTER_REF'
  | 'DANGLING_SPELL_REF'
  | 'DANGLING_ITEM_REF'
  | 'UNREACHABLE_SCENE'
  | 'INVALID_MAP'
  | 'INVALID_SPAWN'
  | 'UNREACHABLE_SPAWN'
  | 'MONSTER_OUT_OF_SCOPE'
  | 'DENYLISTED_TERM';
export interface AdventureError {
  code: AdventureErrorCode;
  message: string;
}
export type AdventureValidation =
  | { ok: true; adventure: Adventure }
  | { ok: false; errors: AdventureError[] };

function scanText(
  value: unknown,
  path: string,
  errors: AdventureError[],
): void {
  if (typeof value === 'string') {
    const normalized = value.toLocaleLowerCase('en-US');
    for (const term of denylistData) {
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (
        new RegExp(
          `(^|[^\\p{L}\\p{N}])${escaped.toLocaleLowerCase('en-US')}($|[^\\p{L}\\p{N}])`,
          'u',
        ).test(normalized)
      ) {
        errors.push({
          code: 'DENYLISTED_TERM',
          message: `${path} contains denylisted term "${term}"`,
        });
      }
    }
  } else if (Array.isArray(value)) {
    value.forEach((item, i) => scanText(item, `${path}[${i}]`, errors));
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value))
      scanText(item, `${path}.${key}`, errors);
  }
}

function traversable(
  map: Battlemap,
  start: { x: number; y: number },
  goal: { x: number; y: number },
): boolean {
  const terrain = rleDecode(map.cells);
  const blocked = (x: number, y: number) =>
    map.palette[terrain[y * map.w + x] ?? 0]?.blocksMove ?? true;
  const edgeBlocked = (ax: number, ay: number, bx: number, by: number) =>
    map.edges.some(
      (e) =>
        ((e.a.x === ax && e.a.y === ay && e.b.x === bx && e.b.y === by) ||
          (e.b.x === ax && e.b.y === ay && e.a.x === bx && e.a.y === by)) &&
        (e.kind === 'wall' || (e.kind === 'door' && e.state !== 'open')),
    );
  const seen = new Set<string>([`${start.x},${start.y}`]);
  const queue = [start];
  while (queue.length) {
    const cell = queue.shift()!;
    if (cell.x === goal.x && cell.y === goal.y) return true;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const x = cell.x + dx,
        y = cell.y + dy,
        key = `${x},${y}`;
      if (
        x < 0 ||
        y < 0 ||
        x >= map.w ||
        y >= map.h ||
        blocked(x, y) ||
        edgeBlocked(cell.x, cell.y, x, y) ||
        seen.has(key)
      )
        continue;
      seen.add(key);
      queue.push({ x, y });
    }
  }
  return false;
}

export function validateAdventure(
  input: unknown,
  catalog: Catalog,
): AdventureValidation {
  const parsed = AdventureSchema.safeParse(input);
  if (!parsed.success)
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) => ({
        code: 'SCHEMA_INVALID',
        message: `${issue.path.join('.')}: ${issue.message}`,
      })),
    };
  const adventure = parsed.data;
  const errors: AdventureError[] = [];
  const error = (code: AdventureErrorCode, message: string) =>
    errors.push({ code, message });
  const scenes = new Map(adventure.scenes.map((scene) => [scene.id, scene]));
  const encounters = new Map(
    adventure.encounters.map((encounter) => [encounter.id, encounter]),
  );
  const maps = new Map(adventure.maps.map((map) => [map.mapId, map]));
  const npcs = new Set(adventure.npcs.map((npc) => npc.id));
  if (!scenes.has(adventure.startingSceneId))
    error(
      'DANGLING_SCENE_REF',
      `startingSceneId references unknown scene ${adventure.startingSceneId}`,
    );
  for (const scene of adventure.scenes) {
    for (const ref of scene.nextSceneIds)
      if (!scenes.has(ref))
        error(
          'DANGLING_SCENE_REF',
          `scene ${scene.id} references unknown scene ${ref}`,
        );
    for (const ref of scene.encounterIds)
      if (!encounters.has(ref))
        error(
          'DANGLING_ENCOUNTER_REF',
          `scene ${scene.id} references unknown encounter ${ref}`,
        );
    for (const ref of scene.npcIds)
      if (!npcs.has(ref))
        error(
          'DANGLING_SCENE_REF',
          `scene ${scene.id} references unknown NPC ${ref}`,
        );
  }
  const reachableScenes = new Set<string>();
  const pending = [adventure.startingSceneId];
  while (pending.length) {
    const id = pending.pop()!;
    if (reachableScenes.has(id)) continue;
    reachableScenes.add(id);
    for (const next of scenes.get(id)?.nextSceneIds ?? [])
      if (scenes.has(next)) pending.push(next);
  }
  for (const scene of adventure.scenes)
    if (!reachableScenes.has(scene.id))
      error(
        'UNREACHABLE_SCENE',
        `scene ${scene.id} cannot be reached from ${adventure.startingSceneId}`,
      );

  for (const id of adventure.monsterIds)
    if (catalog.get('monster', id) === undefined)
      error('DANGLING_MONSTER_REF', `unknown monster ${id}`);
  for (const id of adventure.spellIds)
    if (catalog.get('spell', id) === undefined)
      error('DANGLING_SPELL_REF', `unknown spell ${id}`);
  for (const id of adventure.itemIds)
    if (catalog.get('equipment', id) === undefined)
      error('DANGLING_ITEM_REF', `unknown item ${id}`);
  for (const encounter of adventure.encounters) {
    for (const id of encounter.monsterIds) {
      const monster = catalog.get('monster', id);
      if (!monster)
        error(
          'DANGLING_MONSTER_REF',
          `encounter ${encounter.id} references unknown monster ${id}`,
        );
      else if (monster.cr > ADVENTURE_MAX_MONSTER_CR)
        error(
          'MONSTER_OUT_OF_SCOPE',
          `encounter ${encounter.id} monster ${id} has CR ${monster.cr}; maximum is ${ADVENTURE_MAX_MONSTER_CR}`,
        );
    }
    for (const reward of encounter.rewards)
      if (catalog.get('equipment', reward.itemId) === undefined)
        error(
          'DANGLING_ITEM_REF',
          `encounter ${encounter.id} references unknown item ${reward.itemId}`,
        );
    const map = maps.get(encounter.mapId);
    if (!map) {
      error(
        'DANGLING_MAP_REF',
        `encounter ${encounter.id} references unknown map ${encounter.mapId}`,
      );
      continue;
    }
    const checked = loadAuthoredMap(map);
    if (!checked.ok)
      for (const issue of checked.errors)
        error(
          'INVALID_MAP',
          `map ${map.mapId}: ${issue.code}: ${issue.message}`,
        );
    const party = map.markers.find(
      (marker) => marker.markerId === encounter.partySpawnMarkerId,
    );
    const enemy = map.markers.find(
      (marker) => marker.markerId === encounter.enemySpawnMarkerId,
    );
    const spawnZones = map.zones
      .filter((zone) => zone.kind === 'spawn')
      .flatMap((zone) => zone.cells);
    const legal = (marker: typeof party) => {
      if (
        !marker ||
        marker.cell.x < 0 ||
        marker.cell.y < 0 ||
        marker.cell.x >= map.w ||
        marker.cell.y >= map.h
      )
        return false;
      const paletteIndex = rleDecode(map.cells)[
        marker.cell.y * map.w + marker.cell.x
      ];
      return (
        paletteIndex !== undefined &&
        !map.palette[paletteIndex]?.blocksMove &&
        (spawnZones.length === 0 ||
          spawnZones.some(
            (cell) => cell.x === marker.cell.x && cell.y === marker.cell.y,
          ))
      );
    };
    if (!legal(party) || !legal(enemy))
      error(
        'INVALID_SPAWN',
        `encounter ${encounter.id} requires legal party and enemy spawn markers`,
      );
    if (party && enemy && !traversable(map, party.cell, enemy.cell))
      error(
        'UNREACHABLE_SPAWN',
        `encounter ${encounter.id} party and enemy spawn cells are not traversably connected`,
      );
  }
  scanText(adventure, 'adventure', errors);
  return errors.length ? { ok: false, errors } : { ok: true, adventure };
}

export function loadAdventure(
  input: unknown,
  catalog: Catalog,
): AdventureValidation {
  return validateAdventure(input, catalog);
}
