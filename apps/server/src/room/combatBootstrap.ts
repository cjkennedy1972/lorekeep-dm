import {
  abilityModifier,
  deriveSheet,
  emptyCombatState,
  proficiencyBonus,
  movementNeighbors,
  type Catalog,
  type CharacterInput,
} from '@game/rules-engine';
import { rleDecode, type Battlemap, type GridPos } from '@game/schema';
import type { MovementEntity } from '@game/rules-engine';
import { runMonsters } from './combatEngine.js';
import { seatEntityId } from './seatEntity.js';
import type {
  CombatAttack,
  CombatEntity,
  RoomCombatState,
} from './combatTypes.js';

type Ev = Record<string, unknown>;
type GameState = Record<string, unknown> & {
  gameEngine?: Record<string, unknown>;
  characters?: Record<string, CharacterInput>;
  combatRoom?: RoomCombatState;
  combatActors?: Record<string, string>;
};
type EngineEntity = {
  id: string;
  name?: string;
  hidden?: boolean;
  team: string;
  pos: GridPos;
  size: number;
  hp: number;
  maxHp: number;
  ac: number;
  speed: number;
};
type ToolAttack = {
  ownerId: string;
  attackBonus: number;
  damage: string;
  damageType: string;
  reachFt?: number;
  range?: { normalFt: number; longFt?: number };
};
/** Party sessions: seat id -> immutable binding snapshot. Entity ids are derived from the seat id. */
export type PartyBindings = ReadonlyMap<
  string,
  { characterSnapshot: Record<string, unknown> }
>;
export type Reconciled = { gameState: GameState; events: Ev[] };

const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
const WEAPON_ATTACKS: Record<
  string,
  {
    damage: string;
    damageType: string;
    finesse?: boolean;
    ranged?: boolean;
    range?: { normalFt: number; longFt: number };
  }
> = {
  'equipment:battleaxe': { damage: '1d8', damageType: 'slashing' },
  'equipment:blowgun': {
    ranged: true,
    damage: '1',
    damageType: 'piercing',
    range: { normalFt: 25, longFt: 100 },
  },
  'equipment:club': { damage: '1d4', damageType: 'bludgeoning' },
  'equipment:dagger': {
    damage: '1d4',
    damageType: 'piercing',
    finesse: true,
    range: { normalFt: 20, longFt: 60 },
  },
  'equipment:dart': {
    damage: '1d4',
    damageType: 'piercing',
    finesse: true,
    range: { normalFt: 20, longFt: 60 },
  },
  'equipment:flail': { damage: '1d8', damageType: 'bludgeoning' },
  'equipment:glaive': { damage: '1d10', damageType: 'slashing' },
  'equipment:greataxe': { damage: '1d12', damageType: 'slashing' },
  'equipment:greatclub': { damage: '1d8', damageType: 'bludgeoning' },
  'equipment:greatsword': { damage: '2d6', damageType: 'slashing' },
  'equipment:halberd': { damage: '1d10', damageType: 'slashing' },
  'equipment:hand-crossbow': {
    ranged: true,
    damage: '1d6',
    damageType: 'piercing',
    range: { normalFt: 30, longFt: 120 },
  },
  'equipment:handaxe': {
    damage: '1d6',
    damageType: 'slashing',
    range: { normalFt: 20, longFt: 60 },
  },
  'equipment:heavy-crossbow': {
    ranged: true,
    damage: '1d10',
    damageType: 'piercing',
    range: { normalFt: 100, longFt: 400 },
  },
  'equipment:javelin': {
    damage: '1d6',
    damageType: 'piercing',
    range: { normalFt: 30, longFt: 120 },
  },
  'equipment:lance': { damage: '1d10', damageType: 'piercing' },
  'equipment:light-crossbow': {
    ranged: true,
    damage: '1d8',
    damageType: 'piercing',
    range: { normalFt: 80, longFt: 320 },
  },
  'equipment:light-hammer': {
    damage: '1d4',
    damageType: 'bludgeoning',
    range: { normalFt: 20, longFt: 60 },
  },
  'equipment:longbow': {
    ranged: true,
    damage: '1d8',
    damageType: 'piercing',
    range: { normalFt: 150, longFt: 600 },
  },
  'equipment:longsword': { damage: '1d8', damageType: 'slashing' },
  'equipment:mace': { damage: '1d6', damageType: 'bludgeoning' },
  'equipment:maul': { damage: '2d6', damageType: 'bludgeoning' },
  'equipment:morningstar': { damage: '1d8', damageType: 'piercing' },
  'equipment:musket': {
    ranged: true,
    damage: '1d12',
    damageType: 'piercing',
    range: { normalFt: 40, longFt: 120 },
  },
  'equipment:pike': { damage: '1d10', damageType: 'piercing' },
  'equipment:pistol': {
    ranged: true,
    damage: '1d10',
    damageType: 'piercing',
    range: { normalFt: 30, longFt: 90 },
  },
  'equipment:quarterstaff': { damage: '1d6', damageType: 'bludgeoning' },
  'equipment:rapier': {
    damage: '1d8',
    damageType: 'piercing',
    finesse: true,
  },
  'equipment:scimitar': {
    damage: '1d6',
    damageType: 'slashing',
    finesse: true,
  },
  'equipment:shortbow': {
    ranged: true,
    damage: '1d6',
    damageType: 'piercing',
    range: { normalFt: 80, longFt: 320 },
  },
  'equipment:shortsword': {
    damage: '1d6',
    damageType: 'piercing',
    finesse: true,
  },
  'equipment:sickle': { damage: '1d4', damageType: 'slashing' },
  'equipment:sling': {
    ranged: true,
    damage: '1d4',
    damageType: 'bludgeoning',
    range: { normalFt: 30, longFt: 120 },
  },
  'equipment:spear': {
    damage: '1d6',
    damageType: 'piercing',
    range: { normalFt: 20, longFt: 60 },
  },
  'equipment:trident': {
    damage: '1d8',
    damageType: 'piercing',
    range: { normalFt: 20, longFt: 60 },
  },
  'equipment:war-pick': { damage: '1d8', damageType: 'piercing' },
  'equipment:warhammer': { damage: '1d8', damageType: 'bludgeoning' },
  'equipment:whip': { damage: '1d4', damageType: 'slashing' },
};

const unarmed = (character: CharacterInput): CombatAttack => {
  const mod = abilityModifier(character.abilities.str);
  return {
    id: 'unarmed',
    name: 'Unarmed strike',
    attackBonus: mod + proficiencyBonus(character.level),
    // SRD unarmed strike deals 1 + Str modifier; a fixed 1d1 keeps the dice grammar NdM[+K]
    damage: `1d1${mod > 0 ? `+${mod}` : mod < 0 ? mod : ''}`,
    damageType: 'bludgeoning',
  };
};
export function attacksFor(
  entity: EngineEntity,
  character: CharacterInput | undefined,
  registry: Record<string, ToolAttack>,
  catalog: Catalog,
): Pick<CombatEntity, 'attacks' | 'abilities' | 'saves'> {
  if (character) {
    const registered = Object.entries(registry)
      .filter(([, attack]) => attack.ownerId === entity.id)
      .map(
        ([id, attack]): CombatAttack => ({
          id,
          name: id,
          attackBonus: attack.attackBonus,
          damage: attack.damage,
          damageType: attack.damageType,
          ...(attack.reachFt ? { reachFt: attack.reachFt } : {}),
          ...(attack.range ? { range: attack.range } : {}),
        }),
      );
    const derived = deriveSheet(character, catalog);
    const weapons = character.equipment.flatMap((item): CombatAttack[] => {
      const weapon = WEAPON_ATTACKS[item.itemId];
      if (!weapon || !item.equipped || item.qty <= 0) return [];
      const strModifier = abilityModifier(character.abilities.str);
      const dexModifier = abilityModifier(character.abilities.dex);
      const modifier = weapon.finesse
        ? Math.max(strModifier, dexModifier)
        : weapon.ranged
          ? dexModifier
          : strModifier;
      return [
        {
          id: item.itemId,
          name: catalog.get('equipment', item.itemId)?.name ?? item.itemId,
          attackBonus: modifier + proficiencyBonus(character.level),
          damage: `${weapon.damage}${modifier > 0 ? `+${modifier}` : modifier < 0 ? modifier : ''}`,
          damageType: weapon.damageType,
          ...(weapon.range ? { range: weapon.range } : {}),
        },
      ];
    });
    const attacks = [
      ...registered,
      ...weapons.filter(
        (weapon) => !registered.some((attack) => attack.id === weapon.id),
      ),
    ];
    return {
      abilities: character.abilities,
      saves: derived.saves,
      attacks: attacks.length ? attacks : [unarmed(character)],
    };
  }
  const catalogId = `monster:${entity.id.replace(/^ent_/, '').replace(/_\d+$/, '')}`;
  const monster = catalog.get('monster', catalogId);
  return {
    abilities: monster?.abilities,
    saves: monster?.saves,
    attacks: (monster?.attacks ?? []).map((attack) => ({
      id: slug(attack.name),
      name: attack.name,
      attackBonus: attack.toHit,
      damage: attack.damage[0]?.dice ?? '1d4',
      damageType: attack.damage[0]?.type ?? 'bludgeoning',
      ...(attack.reachFt ? { reachFt: attack.reachFt } : {}),
      ...(attack.range ? { range: attack.range } : {}),
    })),
  };
}
function partySpawn(
  map: Battlemap & { partySpawnRef?: string },
  taken: readonly { id: string; team: string; pos: GridPos; size: number }[],
  size: number,
): GridPos[] {
  const zones = map.zones.filter((zone) => zone.kind === 'spawn');
  const zone =
    zones.find((z) => /party|pc|player|hero/.test(z.zoneId)) ??
    zones.find((z) => !/foe|enemy|monster/.test(z.zoneId));
  const tiles = rleDecode(map.cells);
  const authored = map.partySpawnRef
    ? map.markers.find((marker) => marker.markerId === map.partySpawnRef)?.cell
    : undefined;
  // A supplied marker is authoritative. A missing referenced marker is invalid;
  // only an encounter with no partySpawnRef uses the legacy spawn-zone fallback.
  if (map.partySpawnRef && !authored) return [];
  const validTerrain = (cell: GridPos) => {
    if (
      cell.x < 0 ||
      cell.y < 0 ||
      cell.x + size > map.w ||
      cell.y + size > map.h
    )
      return false;
    for (let dy = 0; dy < size; dy++)
      for (let dx = 0; dx < size; dx++) {
        const tile = tiles[(cell.y + dy) * map.w + cell.x + dx] ?? 0;
        if (map.palette[tile]?.blocksMove) return false;
      }
    return true;
  };
  const overlapsTaken = (cell: GridPos) =>
    taken.some(
      (entity) =>
        cell.x < entity.pos.x + entity.size &&
        cell.x + size > entity.pos.x &&
        cell.y < entity.pos.y + entity.size &&
        cell.y + size > entity.pos.y,
    );
  if (!authored)
    return (zone?.cells ?? []).filter(
      (cell) => validTerrain(cell) && !overlapsTaken(cell),
    );
  if (!validTerrain(authored)) return [];
  const mover: MovementEntity = {
    id: '__party_spawn_search__',
    team: 'party',
    pos: authored,
    size,
  };
  const state = { map, entities: [...taken, mover] };
  const distances = new Map<string, { cell: GridPos; distance: number }>();
  const queue = [{ cell: authored, distance: 0 }];
  distances.set(`${authored.x},${authored.y}`, queue[0]!);
  while (queue.length) {
    const current = queue.shift()!;
    for (const cell of movementNeighbors(state, mover, current.cell)) {
      const key = `${cell.x},${cell.y}`;
      if (distances.has(key)) continue;
      const next = { cell, distance: current.distance + 1 };
      distances.set(key, next);
      queue.push(next);
    }
  }
  return [...distances.values()]
    .filter(({ cell }) => validTerrain(cell) && !overlapsTaken(cell))
    .sort(
      (a, b) =>
        a.distance - b.distance || a.cell.y - b.cell.y || a.cell.x - b.cell.x,
    )
    .map(({ cell }) => cell);
}

/**
 * ADR-035: re-key the engine's PC entities to the seat-derived stable id and attach the immutable
 * binding snapshot, so party ownership never depends on client ids or reusable character ids.
 */
function bindParty(game: GameState, party: PartyBindings): GameState {
  const ids = new Map<string, string>();
  const characters: Record<string, CharacterInput> = {};
  for (const [seatId, binding] of party) {
    const snapshot = binding.characterSnapshot as unknown as CharacterInput;
    const id = seatEntityId(seatId);
    ids.set(snapshot.id, id);
    characters[seatId] = { ...snapshot, id };
  }
  const engine = game.gameEngine as Record<string, unknown> | undefined;
  if (!engine) return game;
  const remap = (id: string) => ids.get(id) ?? id;
  const rekey = (record: Record<string, unknown> | undefined) =>
    record &&
    Object.fromEntries(Object.entries(record).map(([k, v]) => [remap(k), v]));
  return {
    ...game,
    characters,
    gameEngine: {
      ...engine,
      entities: (engine.entities as EngineEntity[] | undefined)?.map((e) => ({
        ...e,
        id: remap(e.id),
      })),
      ac: rekey(engine.ac as Record<string, unknown> | undefined),
      // Preserve engine-owned HP across party id remapping and later combat settle.
      hp: rekey(engine.hp as Record<string, unknown> | undefined),
      attacks:
        engine.attacks &&
        Object.fromEntries(
          Object.entries(engine.attacks as Record<string, ToolAttack>).map(
            ([k, v]) => [k, { ...v, ownerId: remap(v.ownerId) }],
          ),
        ),
      combat: engine.combat && {
        ...(engine.combat as {
          initiative?: { entityId: string; total: number }[];
        }),
        initiative: (
          (
            engine.combat as {
              initiative?: { entityId: string; total: number }[];
            }
          ).initiative ?? []
        ).map((i) => ({ ...i, entityId: remap(i.entityId) })),
      },
    },
  };
}

function buildRoomCombat(
  game: GameState,
  catalog: Catalog,
): { state: RoomCombatState; actors: Record<string, string> } | null {
  const engine = game.gameEngine as
    | {
        map?: Battlemap;
        entities?: EngineEntity[];
        combat?: {
          initiative: { entityId: string; total: number }[];
        };
        attacks?: Record<string, ToolAttack>;
        ac?: Record<string, number>;
        combatSeed?: number;
      }
    | undefined;
  if (!engine?.map || !engine.entities?.length || !engine.combat) return null;
  const characters = game.characters ?? {};
  const actors = Object.fromEntries(
    Object.entries(characters)
      .filter(([, c]) => engine.entities!.some((e) => e.id === c.id))
      .map(([account, c]) => [account, c.id]),
  );
  const byId = new Map(Object.values(characters).map((c) => [c.id, c]));
  const placed: EngineEntity[] = [];
  const taken = engine.entities.filter((entity) => entity.pos.x >= 0);
  for (const entity of engine.entities) {
    if (entity.pos.x >= 0 || entity.team !== 'party') {
      placed.push(entity);
      continue;
    }
    const cell = partySpawn(engine.map, taken, entity.size)[0];
    if (!cell) return null;
    const positioned = { ...entity, pos: cell };
    placed.push(positioned);
    taken.push(positioned);
  }
  const entities: CombatEntity[] = placed.map((entity) => {
    const character = byId.get(entity.id);
    return {
      id: entity.id,
      ...(entity.name ? { name: entity.name } : {}),
      ...(entity.hidden ? { hidden: true } : {}),
      kind: character ? 'character' : 'monster',
      team: entity.team,
      pos: entity.pos,
      size: entity.size,
      hp: entity.hp,
      maxHp: entity.maxHp,
      ac: engine.ac?.[entity.id] ?? entity.ac,
      speed: entity.speed,
      ...attacksFor(entity, character, engine.attacks ?? {}, catalog),
    };
  });
  const initiative = engine.combat.initiative.map(({ entityId, total }) => ({
    entityId,
    total,
  }));
  if (!initiative.length) return null;
  const first = initiative[0]!.entityId;
  return {
    actors,
    state: {
      phase: 'awaiting-command',
      map: engine.map,
      entities,
      combat: {
        round: 1,
        activeEntityId: first,
        initiative,
        resources: Object.fromEntries(
          entities.map((e) => [
            e.id,
            {
              action: true,
              bonusAction: true,
              bonusActionSpellCast: false,
              actionSpellCast: false,
              reaction: true,
              movementRemaining: e.speed ?? 30,
            },
          ]),
        ),
      },
      seed: engine.combatSeed ?? 1,
    },
  };
}

/** Pure preflight for the production start-combat transaction. */
export function canBootstrapCombat(game: GameState, catalog: Catalog): boolean {
  return buildRoomCombat(game, catalog) !== null;
}

/**
 * Keep the Room's websocket-facing combat in step with what the DM tools did to the engine state:
 * start_combat builds it (monsters then act until a party member is up), end_combat tears it down.
 */
export function reconcileCombat(
  game: GameState,
  catalog: Catalog,
  now: number,
  party?: PartyBindings,
): Reconciled | null {
  const engineCombat = game.gameEngine?.combat as
    | { initiative?: unknown[] }
    | undefined;
  const hasEngineCombat = Array.isArray(engineCombat?.initiative);
  const engineActive = !!engineCombat?.initiative?.length;
  const room = game.combatRoom;
  if (hasEngineCombat && !engineActive && room && !room.ended) {
    const rest = { ...game };
    delete rest.combatRoom;
    delete rest.combatActors;
    return {
      gameState: rest,
      events: [{ type: 'CombatEnded', outcome: 'dm-ended', xp: 0 }],
    };
  }
  if (!engineActive || (room && !room.ended)) return null;
  const built = buildRoomCombat(party ? bindParty(game, party) : game, catalog);
  if (!built) return null;
  const events: Ev[] = [
    {
      type: 'CombatStarted',
      combatants: built.state.entities.map((e) => ({ id: e.id, pos: e.pos })),
      order: built.state.combat.initiative.map(({ entityId }) => entityId),
    },
    {
      type: 'TurnStarted',
      entityId: built.state.combat.activeEntityId,
      round: 1,
    },
  ];
  const run = runMonsters(
    party ? { ...built.state, promptEvents: true } : built.state,
    now,
  );
  return {
    gameState: {
      ...game,
      combatRoom: run.state,
      combatActors: party ? {} : built.actors,
    },
    events: [...events, ...run.events],
  };
}

/** Carry the end of a fought combat back into the engine state and character sheets. */
export function settleEngine(
  game: GameState,
  slots?: { entityId: string; slots: Record<string, unknown> },
): GameState {
  const room = game.combatRoom;
  if (!room) return game;
  const hp = Object.fromEntries(room.entities.map((e) => [e.id, e.hp]));
  const characters = Object.fromEntries(
    Object.entries(game.characters ?? {}).map(([account, c]) => [
      account,
      {
        ...c,
        hp: { ...c.hp, current: hp[c.id] ?? c.hp.current },
        ...(slots && slots.entityId === c.id
          ? { slots: slots.slots as CharacterInput['slots'] }
          : {}),
      },
    ]),
  );
  const engine = game.gameEngine ?? {};
  const next: GameState = { ...game, characters };
  if (!room.ended) {
    return {
      ...next,
      gameEngine: { ...engine, actors: characters },
    };
  }
  return {
    ...next,
    gameEngine: {
      ...engine,
      actors: characters,
      hp: { ...(engine.hp as object), ...hp },
      entities: ((engine.entities as EngineEntity[] | undefined) ?? []).map(
        (e) => ({ ...e, hp: hp[e.id] ?? e.hp }),
      ),
      combat: emptyCombatState(),
    },
  };
}
