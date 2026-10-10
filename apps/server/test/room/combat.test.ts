import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Room, type RoomStore } from '../../src/room/Room.js';
import {
  combatTracker,
  createCombatRuntime,
  type RoomCombatState,
} from '../../src/room/combat.js';
import type { LatestState, StoredEvent } from '../../src/persistence/index.js';

const sessionId = randomUUID();
const lease = {
  sessionId,
  nodeId: 'node',
  epoch: 1,
  expiresAt: new Date(Date.now() + 60_000),
};
const map: RoomCombatState['map'] = {
  mapId: 'test',
  w: 8,
  h: 8,
  palette: [
    {
      terrainId: 'floor',
      moveCost: 1,
      blocksMove: false,
      blocksSight: false,
      cover: 'none',
      elevation: 0,
    },
  ],
  cells: [0, 64],
  edges: [],
  features: [],
  markers: [],
  zones: [],
  diagonalRule: '5ft',
};
const combat: RoomCombatState = {
  map,
  entities: [
    {
      id: 'ent_hero',
      kind: 'character',
      team: 'party',
      pos: { x: 1, y: 1 },
      size: 1,
      hp: 12,
      maxHp: 12,
      attacks: [
        {
          id: 'sword',
          name: 'Sword',
          attackBonus: 5,
          damage: '1d8+3',
          damageType: 'slashing',
          reachFt: 5,
        },
      ],
    },
    {
      id: 'ent_goblin',
      kind: 'monster',
      team: 'enemies',
      pos: { x: 5, y: 1 },
      size: 1,
      hp: 7,
      maxHp: 7,
    },
  ],
  combat: {
    round: 1,
    activeEntityId: 'ent_hero',
    initiative: [
      { entityId: 'ent_hero', total: 18 },
      { entityId: 'ent_goblin', total: 12 },
    ],
    resources: {
      ent_hero: {
        action: true,
        bonusAction: true,
        reaction: true,
        movementRemaining: 30,
      },
      ent_goblin: {
        action: true,
        bonusAction: true,
        reaction: true,
        movementRemaining: 30,
      },
    },
  },
};
function setup() {
  const events: StoredEvent[] = [];
  let snapshot: LatestState['snapshot'] = null;
  const store: RoomStore = {
    async loadLatest() {
      return { snapshot, events: [] };
    },
    async writeTurn(_id, inputs, state) {
      const stored = inputs.map((input, index) => ({
        ...input,
        seq: events.length + index + 1,
        sessionId,
        ts: new Date(),
      })) as StoredEvent[];
      events.push(...stored);
      snapshot = {
        sessionId,
        seq: events.length,
        state,
        createdAt: new Date(),
      };
      return { events: stored };
    },
  };
  const room = new Room(store, lease, { snapshot: null, events: [] });
  return { room, events, latestSnapshot: () => snapshot };
}

describe('Room combat command seam', () => {
  it('rejects another account and non-active actor without mutating combat state', async () => {
    const { room, events } = setup();
    const owner = randomUUID(),
      intruder = randomUUID();
    await room.join(owner, { send() {} });
    await room.join(intruder, { send() {} });
    // State is restored through a persisted commit, as it would be on room recovery.
    await room.persistRegistry([]).catch(() => undefined);
    const denied = createCombatRuntime().execute(combat, 'ent_goblin', {
      command: 'move',
      destination: { x: 4, y: 1 },
    });
    expect(denied).toMatchObject({ code: 'NOT_YOUR_TURN' });
    expect(combat.entities[0]?.pos).toEqual({ x: 1, y: 1 });
    expect(events).toHaveLength(4);
  });

  it('ends a target concentration when a hit damages it', () => {
    const runtime = createCombatRuntime();
    const engaged: RoomCombatState = {
      ...combat,
      entities: combat.entities.map((entity) =>
        entity.id === 'ent_hero' ? { ...entity, pos: { x: 4, y: 1 } } : entity,
      ),
      concentration: { ent_goblin: 'srd:spell/bless' },
    };
    const result = runtime.execute(engaged, 'ent_hero', {
      command: 'attack',
      targetId: 'ent_goblin',
      attackId: 'sword',
    });
    if ('code' in result) throw new Error(result.code);
    expect(result.events.some((event) => event.type === 'HpChanged')).toBe(
      true,
    );
    expect(result.state.concentration?.ent_goblin ?? null).toBeNull();
  });

  it('persists an accepted websocket combat move and rejects another seated account', async () => {
    const { room, events, latestSnapshot } = setup();
    const owner = randomUUID();
    const intruder = randomUUID();
    await room.join(owner, { send() {} });
    await room.join(intruder, { send() {} });
    room.state = {
      ...room.state,
      gameState: { combatRoom: combat, combatActors: { [owner]: 'ent_hero' } },
    };
    const actionId = randomUUID();
    expect(
      await room.submitCombatCommand(owner, actionId, {
        command: 'move',
        destination: { x: 3, y: 1 },
      }),
    ).toBe(true);
    const saved = latestSnapshot()?.state as {
      gameState?: { combatRoom?: RoomCombatState };
      actionIds?: string[];
    };
    expect(saved.gameState?.combatRoom?.entities[0]?.pos).toEqual({
      x: 3,
      y: 1,
    });
    expect(saved.actionIds).toContain(actionId);
    const count = events.length;
    expect(
      await room.submitCombatCommand(intruder, randomUUID(), {
        command: 'move',
        destination: { x: 2, y: 1 },
      }),
    ).toBe(true);
    expect(events).toHaveLength(count);
  });

  it('uses the engine path for valid movement and rejects an unreachable move unchanged', () => {
    const runtime = createCombatRuntime();
    const valid = runtime.execute(combat, 'ent_hero', {
      command: 'move',
      destination: { x: 3, y: 1 },
    });
    expect(valid).toMatchObject({
      state: {
        entities: expect.arrayContaining([
          expect.objectContaining({ id: 'ent_hero', pos: { x: 3, y: 1 } }),
        ]),
      },
      events: [{ type: 'EntityMoved', cost: 10 }],
    });
    const invalid = runtime.execute(combat, 'ent_hero', {
      command: 'move',
      destination: { x: 8, y: 8 },
    });
    expect(invalid).toMatchObject({ code: 'COMMAND_REJECTED' });
    expect(combat.entities[0]?.pos).toEqual({ x: 1, y: 1 });
  });

  it('resolves attacks with engine dice and spends the action only when legal', () => {
    const runtime = createCombatRuntime();
    const nearby = {
      ...combat,
      entities: combat.entities.map((entity) =>
        entity.id === 'ent_goblin'
          ? { ...entity, pos: { x: 2, y: 1 }, ac: 10 }
          : entity,
      ),
    };
    const hit = runtime.execute(nearby, 'ent_hero', {
      command: 'attack',
      targetId: 'ent_goblin',
      attackId: 'sword',
    });
    expect(hit).not.toMatchObject({ code: 'COMMAND_REJECTED' });
    if (!('code' in hit)) {
      expect(hit.events.some((event) => event.type === 'RollEvent')).toBe(true);
      expect(hit.state.combat.resources.ent_hero?.action).toBe(false);
    }
    const illegal = runtime.execute(combat, 'ent_hero', {
      command: 'attack',
      targetId: 'ent_goblin',
      attackId: 'sword',
    });
    expect(illegal).toMatchObject({ code: 'COMMAND_REJECTED' });
    expect(combat.combat.resources.ent_hero?.action).toBe(true);
  });

  it('keeps the active token first and hides exact enemy HP in the tracker', () => {
    const tracker = combatTracker(combat);
    expect(tracker.activeEntityId).toBe(combat.combat.initiative[0]?.entityId);
    expect(tracker.entities[0]).toMatchObject({ id: 'ent_hero', hp: 12 });
    expect(tracker.entities[1]).toMatchObject({
      id: 'ent_goblin',
      hpState: 'healthy',
    });
    expect(tracker.entities[1]).not.toHaveProperty('hp');
  });
});
