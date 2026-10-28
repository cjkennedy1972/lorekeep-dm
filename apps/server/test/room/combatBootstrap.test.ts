import {
  AdventureSchema,
  rleDecode,
  rleEncode,
  type Battlemap,
} from '@game/schema';
import { describe, expect, it } from 'vitest';
import adventureData from '../../../../packages/engine/adventures/01/adventure.json' with { type: 'json' };
import { reconcileCombat } from '../../src/room/combatBootstrap.js';
import { catalog, hero } from './combatFixtures.js';

const adventure = AdventureSchema.parse(adventureData);
const encounters = ['encounter-e2-lookouts', 'encounter-e3-skarrik'] as const;

function bootstrapParty(
  encounterId: string,
  count: number,
  mapOverride?: Battlemap,
  useAuthoredMarker = true,
) {
  const encounter = adventure.encounters.find(
    (item) => item.id === encounterId,
  )!;
  const authoredMap = adventure.maps.find(
    (item) => item.mapId === encounter.mapId,
  )!;
  const map = {
    ...(mapOverride ?? authoredMap),
    ...(useAuthoredMarker
      ? { partySpawnRef: encounter.partySpawnMarkerId }
      : {}),
  } as Battlemap & { partySpawnRef?: string };
  const party = Array.from({ length: count }, (_, index) => ({
    ...hero,
    id: `ent_party_${index + 1}`,
    name: `Party ${index + 1}`,
  }));
  const enemyMarker = map.markers.find(
    (marker) => marker.markerId === encounter.enemySpawnMarkerId,
  )!;
  const entities = [
    ...party.map((character) => ({
      id: character.id,
      name: character.name,
      team: 'party',
      pos: { x: -100, y: -100 },
      size: 1,
      hp: 30,
      maxHp: 30,
      ac: 12,
      speed: 30,
    })),
    {
      id: 'ent_test_enemy',
      team: 'enemies',
      pos: enemyMarker.cell,
      size: 1,
      hp: 8,
      maxHp: 8,
      ac: 13,
      speed: 30,
    },
  ];
  const game = {
    characters: Object.fromEntries(
      party.map((character, index) => [`account-${index + 1}`, character]),
    ),
    gameEngine: {
      map,
      entities,
      ac: {},
      attacks: {},
      combat: {
        initiative: [
          ...party.map((character, index) => ({
            entityId: character.id,
            total: 20 - index,
          })),
          { entityId: 'ent_test_enemy', total: 1 },
        ],
      },
    },
  };
  return { result: reconcileCombat(game, catalog, 1_000), map, enemyMarker };
}

describe('party placement during combat bootstrap', () => {
  it.each(
    encounters.flatMap((encounterId) =>
      [2, 3, 4].map((count) => [count, encounterId] as const),
    ),
  )(
    'places %i party members at the authored marker for %s',
    (count, encounterId) => {
      const { result, map, enemyMarker } = bootstrapParty(encounterId, count);
      expect(result).not.toBeNull();
      const entities = result!.gameState.combatRoom!.entities;
      const party = entities.filter((entity) => entity.team === 'party');
      expect(party).toHaveLength(count);
      expect(party[0]!.pos).toEqual(
        map.markers.find((marker) => marker.markerId === map.partySpawnRef)!
          .cell,
      );
      const occupied = entities.filter((entity) => entity.team !== 'party');
      const terrain = rleDecode(map.cells);
      expect(new Set(party.map(({ pos }) => `${pos.x},${pos.y}`)).size).toBe(
        count,
      );
      for (const entity of party) {
        expect(entity.pos).not.toEqual(enemyMarker.cell);
        expect(
          map.palette[terrain[entity.pos.y * map.w + entity.pos.x] ?? 0]
            ?.blocksMove,
        ).toBe(false);
        expect(
          occupied.some(
            (other) =>
              entity.pos.x < other.pos.x + other.size &&
              entity.pos.x + entity.size > other.pos.x &&
              entity.pos.y < other.pos.y + other.size &&
              entity.pos.y + entity.size > other.pos.y,
          ),
        ).toBe(false);
      }
    },
  );

  it('uses the party spawn zone when no authored party marker is present', () => {
    const encounterId = encounters[0];
    const { result, map } = bootstrapParty(encounterId, 3, undefined, false);
    expect(result).not.toBeNull();
    const positions = result!.gameState
      .combatRoom!.entities.filter((entity) => entity.team === 'party')
      .map(({ pos }) => pos);
    const zone = map.zones.find((item) => item.zoneId === 'zone-e2-party')!;
    expect(positions).toEqual(zone.cells.slice(0, 3));
  });

  it('fails bootstrap when the map cannot fit every party member', () => {
    const encounterId = encounters[0];
    const { map, enemyMarker } = bootstrapParty(encounterId, 2);
    const anchor = map.markers.find(
      (marker) => marker.markerId === map.partySpawnRef,
    )!.cell;
    const grid = Array.from({ length: map.w * map.h }, () => 1);
    grid[anchor.y * map.w + anchor.x] = 0;
    grid[enemyMarker.cell.y * map.w + enemyMarker.cell.x] = 0;
    const blockedMap: Battlemap = {
      ...map,
      palette: [
        map.palette[0]!,
        { ...map.palette[0]!, terrainId: 'stone-wall', blocksMove: true },
      ],
      cells: rleEncode(grid),
    };
    expect(bootstrapParty(encounterId, 2, blockedMap).result).toBeNull();
  });
});
