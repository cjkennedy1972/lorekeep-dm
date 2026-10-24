import {
  abilityModifier,
  deriveSheet,
  emptyCombatState,
  proficiencyBonus,
  type Catalog,
  type CharacterInput,
} from '@game/rules-engine';
import { rleDecode, type Battlemap, type GridPos } from '@game/schema';
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
    const owned = Object.entries(registry)
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
    return {
      abilities: character.abilities,
      saves: deriveSheet(character, catalog).saves,
      attacks: owned.length ? owned : [unarmed(character)],
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
  map: Battlemap,
  taken: readonly { pos: GridPos; size: number }[],
): GridPos[] {
  const zones = map.zones.filter((zone) => zone.kind === 'spawn');
  const zone =
    zones.find((z) => /party|pc|player|hero/.test(z.zoneId)) ??
    zones.find((z) => !/foe|enemy|monster/.test(z.zoneId));
  const tiles = rleDecode(map.cells);
  return (zone?.cells ?? []).filter(
    (cell) =>
      !map.palette[tiles[cell.y * map.w + cell.x] ?? 0]?.blocksMove &&
      !taken.some(
        (t) =>
          cell.x >= t.pos.x &&
          cell.x < t.pos.x + t.size &&
          cell.y >= t.pos.y &&
          cell.y < t.pos.y + t.size,
      ),
  );
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
  const engine = game.gameEngine as Record<string, any> | undefined;
  if (!engine) return game;
  const remap = (id: string) => ids.get(id) ?? id;
  const rekey = (record: Record<string, any> | undefined) =>
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
      ac: rekey(engine.ac),
      // Preserve engine-owned HP across party id remapping and later combat settle.
      hp: rekey(engine.hp),
      attacks:
        engine.attacks &&
        Object.fromEntries(
          Object.entries(engine.attacks as Record<string, ToolAttack>).map(
            ([k, v]) => [k, { ...v, ownerId: remap(v.ownerId) }],
          ),
        ),
      combat: engine.combat && {
        ...engine.combat,
        initiative: (
          engine.combat.initiative as { entityId: string; total: number }[]
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
  const spawn = partySpawn(
    engine.map,
    engine.entities.filter((e) => e.pos.x >= 0),
  );
  for (const entity of engine.entities) {
    if (entity.pos.x >= 0 || entity.team !== 'party') {
      placed.push(entity);
      continue;
    }
    const cell = spawn.shift();
    if (!cell) return null;
    placed.push({ ...entity, pos: cell });
  }
  const entities: CombatEntity[] = placed.map((entity) => {
    const character = byId.get(entity.id);
    return {
      id: entity.id,
      ...(entity.name ? { name: entity.name } : {}),
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
    },
    {
      type: 'TurnStarted',
      entityId: built.state.combat.activeEntityId,
      round: 1,
    },
  ];
  const run = runMonsters(built.state, now);
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
