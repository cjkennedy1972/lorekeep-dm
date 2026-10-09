import { readFileSync } from 'node:fs';
import { BattlemapSchema, type Battlemap } from '@game/schema';
import { loadAuthoredMap, type CharacterInput } from '@game/rules-engine';
import { execute, loadCatalog } from '@game/rules-engine/room-tools';
import { mergeCombatOutput } from '../../src/room/productionTurnRunner.js';
import {
  createCombatRuntime,
  type RoomCombatState,
} from '../../src/room/combat.js';

export const catalog = loadCatalog();
const cryptJson = JSON.parse(
  readFileSync(
    new URL(
      '../../../../packages/engine/maps/crypt-room.json',
      import.meta.url,
    ),
    'utf8',
  ),
);
const loaded = loadAuthoredMap(BattlemapSchema.parse(cryptJson));
if (!loaded.ok) throw new Error('crypt map failed validation');
export const cryptMap: Battlemap = loaded.map;

export const hero: CharacterInput = {
  id: 'ent_aria',
  name: 'Aria',
  speciesId: 'species:human',
  classId: 'class:wizard',
  backgroundId: 'background:sage',
  level: 1,
  abilities: { str: 10, dex: 14, con: 14, int: 16, wis: 10, cha: 10 },
  proficiencies: { skills: [], saves: ['int', 'wis'], tools: [] },
  equipment: [],
  spellsKnown: ['spell:burning-hands'],
  spellsPrepared: ['spell:burning-hands'],
  slots: { '1': { max: 2, used: 0 } },
  hp: { current: 30, max: 30, temp: 0 },
  conditions: [],
};
export const account = '11111111-1111-4111-8111-111111111111';
export const world = {
  npcs: {},
  locations: {},
  quests: {},
  flags: {},
  rulings: [],
};

/** The engine state a table holds before the DM calls start_combat: a loaded map and one party member. */
export function preCombatGame(character: CharacterInput = hero) {
  return {
    characters: { [account]: character },
    gameEngine: {
      actors: { [character.id]: character },
      attacks: {
        staff: {
          id: 'staff',
          ownerId: character.id,
          attackBonus: 4,
          damage: '1d6+2',
          damageType: 'bludgeoning',
          targetAc: 10,
          targetKind: 'monster',
        },
      },
      hp: { [character.id]: character.hp.current },
      ac: { [character.id]: 12 },
      conditions: {},
      map: cryptMap,
      world,
    },
  };
}

/** Run the real start_combat executor and fold its output exactly as the production runner does. */
export function startCombat(
  seed: number,
  args: unknown = {
    enemies: [{ monsterId: 'srd:monster/goblin-minion', count: 2 }],
    ambushSide: 'party',
  },
) {
  const game = preCombatGame();
  const result = execute(
    { ...game.gameEngine, catalog } as never,
    { name: 'start_combat', args },
    seed,
  );
  if (!result.ok) throw new Error(`start_combat failed: ${result.error}`);
  return {
    ...game,
    gameEngine: mergeCombatOutput(
      game.gameEngine,
      'start_combat',
      result.value,
    ),
  };
}

/** Bootstrapped Room combat for a fixed seed, party first. */
export function bootstrapped(seed = 7) {
  const runtime = createCombatRuntime(catalog);
  const rec = runtime.reconcile(startCombat(seed), 1_000);
  if (!rec) throw new Error('combat was not bootstrapped');
  const state = (rec.gameState as { combatRoom: RoomCombatState }).combatRoom;
  return { runtime, state, game: rec.gameState, events: rec.events };
}

/** Same combat with entities moved by hand (for adjacency setups). */
export function placed(
  state: RoomCombatState,
  positions: Record<string, { x: number; y: number }>,
): RoomCombatState {
  return {
    ...state,
    entities: state.entities.map((e) =>
      positions[e.id] ? { ...e, pos: positions[e.id]! } : e,
    ),
  };
}

import { randomUUID } from 'node:crypto';
import type { ServerMessage } from '@game/schema';
import { Room, type RoomStore } from '../../src/room/Room.js';
import type { LatestState, StoredEvent } from '../../src/persistence/index.js';
import type { SoloTurnRunner } from '../../src/room/dmTurn.js';

/** An in-memory RoomStore whose latest snapshot can be handed to a fresh Room, i.e. a process restart. */
export function memoryTable(gameState: unknown, runner?: SoloTurnRunner) {
  const sessionId = randomUUID();
  const events: StoredEvent[] = [];
  const lease = {
    sessionId,
    nodeId: 'node',
    epoch: 1,
    expiresAt: new Date(Date.now() + 86_400_000),
  };
  let snapshot: LatestState['snapshot'] = {
    sessionId,
    seq: 1,
    state: {
      sessionId,
      phase: 'lobby',
      seats: [
        {
          seatId: randomUUID(),
          accountId: account,
          displayName: 'Aria',
          presence: 'offline',
        },
      ],
      gameState,
    },
    createdAt: new Date(),
  };
  const store: RoomStore = {
    async loadLatest() {
      return { snapshot, events: [] };
    },
    async writeTurn(_id, inputs, state) {
      const stored = inputs.map((input, index) => ({
        ...input,
        seq: (snapshot?.seq ?? 0) + index + 1,
        sessionId,
        ts: new Date(),
      })) as StoredEvent[];
      events.push(...stored);
      snapshot = {
        sessionId,
        seq: stored.at(-1)!.seq,
        state,
        createdAt: new Date(),
      };
      return { events: stored };
    },
  };
  const boot = () => new Room(store, lease, { snapshot, events: [] }, runner);
  const messages: ServerMessage[] = [];
  const connection = { send: (m: ServerMessage) => void messages.push(m) };
  return {
    boot,
    events,
    messages,
    connection,
    snapshot: () => snapshot,
    game: () =>
      (snapshot?.state as { gameState?: Record<string, unknown> }).gameState!,
  };
}
