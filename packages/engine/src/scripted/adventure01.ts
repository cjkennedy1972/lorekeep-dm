import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Battlemap, GridPos } from '@game/schema';
import adventure from '../../adventures/01/adventure.json' with { type: 'json' };
import { loadCatalog } from '../catalog/load.js';
import { loadAuthoredMap } from '../map/load.js';
import { Sim, abilities, type SimSpec } from './sim.js';

const catalog = loadCatalog();
const mapById = new Map(adventure.maps.map((map) => [map.mapId, map]));
const monsterSpec = (id: string, pos: GridPos, i: number): SimSpec => {
  const data = catalog.get('monster', id);
  if (
    !data ||
    data.kind !== 'monster' ||
    !data.attacks?.length ||
    !data.abilities ||
    !data.footprint ||
    !data.speed
  )
    throw new Error(`Incomplete adventure monster ${id}`);
  const attack = data.attacks.find((a) => a.reachFt) ?? data.attacks[0]!;
  return {
    id: `${id.split(':')[1]}-${i}`,
    team: 'foe',
    pos,
    size: data.footprint,
    hp: data.hp,
    ac: data.ac,
    speed: data.speed,
    abilities: data.abilities,
    attackBonus: attack.toHit,
    damage: attack.damage[0]!.dice,
    damageType: attack.damage[0]!.type,
  };
};
const hero: SimSpec = {
  id: 'pc-adventurer',
  team: 'pc',
  pos: { x: 0, y: 0 },
  size: 1,
  hp: 45,
  ac: 18,
  speed: 30,
  abilities: abilities({ str: 18, dex: 14, con: 16 }),
  attackBonus: 7,
  damage: '1d8+4',
  damageType: 'slashing',
  saveProficiencies: ['str', 'con'],
};
const spawnCells = (map: Battlemap, markerId: string) => {
  const marker = map.markers.find((m) => m.markerId === markerId);
  if (!marker) throw new Error(`Missing marker ${markerId}`);
  const zone = map.zones.find(
    (z) =>
      z.kind === 'spawn' &&
      z.cells.some((c) => c.x === marker.cell.x && c.y === marker.cell.y),
  );
  return zone?.cells ?? [marker.cell];
};

/** Deterministic no-LLM combat run for each authored encounter, using the encounter map/spawns. */
export function runAdventure01Encounter(encounterId: string, seed = 31031) {
  const encounter = adventure.encounters.find(
    (item) => item.id === encounterId,
  );
  if (!encounter)
    throw new Error(`Unknown Adventure #1 encounter ${encounterId}`);
  const rawMap = mapById.get(encounter.mapId);
  if (!rawMap) throw new Error(`Missing map ${encounter.mapId}`);
  const validated = loadAuthoredMap(rawMap);
  if (!validated.ok)
    throw new Error(validated.errors.map((e) => e.message).join(', '));
  const map = validated.map;
  const parties = spawnCells(map, encounter.partySpawnMarkerId);
  const enemies = spawnCells(map, encounter.enemySpawnMarkerId);
  const specs: SimSpec[] = [{ ...hero, pos: parties[0]! }];
  encounter.monsterIds.forEach((monsterId, i) =>
    specs.push(monsterSpec(monsterId, enemies[i % enemies.length]!, i + 1)),
  );
  const sim = new Sim(`adventure01-${encounterId}`, seed, map, specs);
  return sim.run((state, entity) => state.policyTurn(entity), {
    maxRounds: 30,
  });
}
export function validateAdventure01MapFiles() {
  return adventure.maps.map((map) => {
    const file = fileURLToPath(
      new URL(`../../maps/${map.mapId}.json`, import.meta.url),
    );
    const onDisk = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    return loadAuthoredMap(onDisk);
  });
}
