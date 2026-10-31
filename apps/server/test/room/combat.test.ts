import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { Room, type RoomStore } from '../../src/room/Room.js';
import {
  combatTracker,
  createCombatRuntime,
  type RoomCombatState,
} from '../../src/room/combat.js';
import { advanceTurn } from '../../src/room/combatEngine.js';
import type { LatestState, StoredEvent } from '../../src/persistence/index.js';
import type { SoloTurnRunner } from '../../src/room/dmTurn.js';
import { joinSeated } from '../helpers/room.js';

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

describe('combat turn resource refresh', () => {
  it('resets spell-pairing flags when an entity starts its turn', () => {
    const transition = advanceTurn({
      ...combat,
      combat: {
        ...combat.combat,
        resources: {
          ...combat.combat.resources,
          ent_goblin: {
            ...combat.combat.resources.ent_goblin!,
            bonusActionSpellCast: true,
            actionSpellCast: true,
          },
        },
      },
    });

    expect(
      transition.state.combat.resources.ent_goblin?.bonusActionSpellCast,
    ).toBe(false);
    expect(transition.state.combat.resources.ent_goblin?.actionSpellCast).toBe(
      false,
    );
  });

  it('reveals a hidden occupied destination and stops the mover on the last free cell', () => {
    const hiddenCombat: RoomCombatState = {
      ...combat,
      entities: combat.entities.map((entity) =>
        entity.id === 'ent_goblin'
          ? { ...entity, pos: { x: 3, y: 1 }, hidden: true }
          : entity,
      ),
    };
    const result = createCombatRuntime().execute(hiddenCombat, 'ent_hero', {
      command: 'move',
      destination: { x: 3, y: 1 },
    });
    expect('code' in result).toBe(false);
    if ('code' in result) return;
    expect(
      result.state.entities.find((entity) => entity.id === 'ent_hero')?.pos,
    ).toEqual({ x: 2, y: 0 });
    expect(
      result.state.entities.find((entity) => entity.id === 'ent_goblin')
        ?.hidden,
    ).toBe(false);
    expect(result.events).toContainEqual({
      type: 'EntityRevealed',
      entityId: 'ent_goblin',
      cause: 'bump',
    });
    expect(result.events).toContainEqual({
      type: 'MovementSpent',
      entityId: 'ent_hero',
      feet: 5,
    });
  });

  it.each([2, 3])(
    'bumps on a hidden cell in a 1-wide path to %i',
    (destination) => {
      const corridorMap = {
        ...map,
        w: 8,
        h: 1,
        cells: [0, 8] as [number, number],
      };
      const hiddenCombat: RoomCombatState = {
        ...combat,
        map: corridorMap,
        entities: combat.entities.map((entity) =>
          entity.id === 'ent_hero'
            ? { ...entity, pos: { x: 0, y: 0 } }
            : { ...entity, pos: { x: 2, y: 0 }, hidden: true },
        ),
      };
      const result = createCombatRuntime().execute(hiddenCombat, 'ent_hero', {
        command: 'move',
        destination: { x: destination, y: 0 },
      });
      expect('code' in result).toBe(false);
      if ('code' in result) return;
      expect(
        result.state.entities.find((entity) => entity.id === 'ent_hero')?.pos,
      ).toEqual({ x: 1, y: 0 });
      expect(result.events).toContainEqual({
        type: 'EntityRevealed',
        entityId: 'ent_goblin',
        cause: 'bump',
      });
      expect(result.events).toContainEqual({
        type: 'MovementSpent',
        entityId: 'ent_hero',
        feet: 5,
      });
      expect(result.state.combat.resources.ent_hero?.movementRemaining).toBe(
        25,
      );
    },
  );

  it('reveals a hidden attacker with cause attack', () => {
    const hiddenAttacker: RoomCombatState = {
      ...combat,
      entities: combat.entities.map((entity) =>
        entity.id === 'ent_hero'
          ? { ...entity, hidden: true }
          : entity.id === 'ent_goblin'
            ? { ...entity, pos: { x: 2, y: 1 } }
            : entity,
      ),
    };
    const result = createCombatRuntime().execute(hiddenAttacker, 'ent_hero', {
      command: 'attack',
      targetId: 'ent_goblin',
      attackId: 'sword',
    });
    expect('code' in result).toBe(false);
    if ('code' in result) return;
    expect(
      result.state.entities.find((entity) => entity.id === 'ent_hero')?.hidden,
    ).toBe(false);
    expect(result.events).toContainEqual({
      type: 'EntityRevealed',
      entityId: 'ent_hero',
      cause: 'attack',
    });
  });

  it('applies defensive Dodge through the combat command seam', () => {
    const result = createCombatRuntime().execute(combat, 'ent_hero', {
      command: 'dodge',
    });
    expect('code' in result).toBe(false);
    if ('code' in result) return;
    expect(result.events).toContainEqual({
      type: 'DodgeDeclared',
      entityId: 'ent_hero',
    });
    expect(result.state.combat.resources.ent_hero?.action).toBe(false);
    expect(result.state.dodging).toContain('ent_hero');
  });
});

function setup(runner?: SoloTurnRunner) {
  const events: StoredEvent[] = [];
  let snapshot: LatestState['snapshot'] = null;
  const store: RoomStore = {
    async isAccountActive() {
      return true;
    },
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
  const room = new Room(store, lease, { snapshot: null, events: [] }, runner);
  return { room, events, store, latestSnapshot: () => snapshot };
}

describe('Room combat command seam', () => {
  it('limits an away active actor to defensive Dodge and ends that turn', async () => {
    const { room, events } = setup();
    const awayAccount = randomUUID();
    const activeAccount = randomUUID();
    await joinSeated(room, awayAccount, { send() {} });
    await joinSeated(room, activeAccount, { send() {} });
    room.state = {
      ...room.state,
      seats: room.state.seats.map((seat) =>
        seat.accountId === awayAccount ? { ...seat, presence: 'away' } : seat,
      ),
      gameState: {
        combatRoom: {
          ...combat,
          combat: {
            ...combat.combat,
            activeEntityId: 'ent_goblin',
            initiative: [
              { entityId: 'ent_goblin', total: 18 },
              { entityId: 'ent_hero', total: 12 },
            ],
          },
        },
        combatActors: {
          [awayAccount]: 'ent_hero',
          [activeAccount]: 'ent_goblin',
        },
      },
    };

    await room.submitCombatCommand(activeAccount, randomUUID(), {
      command: 'end-turn',
    });
    await vi.waitFor(() => {
      expect(events.some((event) => event.type === 'AutopilotActed')).toBe(
        true,
      );
    });

    const autopilot = events.find((event) => event.type === 'AutopilotActed');
    expect(autopilot?.payload).toMatchObject({
      action: 'dodge',
      reason: 'away-at-turn-start',
      consumable: 'none',
    });
    expect(events.some((event) => event.type === 'DodgeDeclared')).toBe(true);
    expect(events.some((event) => event.type === 'AttackResolved')).toBe(false);
    expect(
      events.filter((event) => event.type === 'TurnEnded').length,
    ).toBeGreaterThanOrEqual(2);
    await room.drain();
  });
  it('rejects another account and non-active actor without mutating combat state', async () => {
    const { room, events } = setup();
    const owner = randomUUID(),
      intruder = randomUUID();
    await joinSeated(room, owner, { send() {} });
    await joinSeated(room, intruder, { send() {} });
    // State is restored through a persisted commit, as it would be on room recovery.
    await room.persistRegistry([]).catch(() => undefined);
    const denied = createCombatRuntime().execute(combat, 'ent_goblin', {
      command: 'move',
      destination: { x: 4, y: 1 },
    });
    expect(denied).toMatchObject({ code: 'not-your-turn' });
    expect(combat.entities[0]?.pos).toEqual({ x: 1, y: 1 });
    expect(events).toHaveLength(4);
  });

  it('makes a CON save when a hit damages a concentrating target', () => {
    const runtime = createCombatRuntime();
    const engaged: RoomCombatState = {
      ...combat,
      entities: combat.entities.map((entity) => {
        if (entity.id === 'ent_hero') return { ...entity, pos: { x: 4, y: 1 } };
        return { ...entity, hp: 40, maxHp: 40 };
      }),
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
    const saves = result.events.filter(
      (event) => event.type === 'RollEvent' && event.kind === 'save',
    );
    expect(saves).toHaveLength(1);
    const dropped = result.events.some(
      (event) => event.type === 'ConcentrationDropped',
    );
    const replay = runtime.execute(engaged, 'ent_hero', {
      command: 'attack',
      targetId: 'ent_goblin',
      attackId: 'sword',
    });
    expect(replay).toEqual(result);
    expect(result.state.concentration?.ent_goblin ?? null).toBe(
      dropped ? null : 'srd:spell/bless',
    );
  });

  it('persists an accepted websocket combat move and rejects another seated account', async () => {
    const { room, events, latestSnapshot } = setup();
    const owner = randomUUID();
    const intruder = randomUUID();
    await joinSeated(room, owner, { send() {} });
    await joinSeated(room, intruder, { send() {} });
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

  it('restores the revealed hidden blocker from the committed snapshot after restart', async () => {
    const { room, events, store, latestSnapshot } = setup();
    const owner = randomUUID();
    await joinSeated(room, owner, { send() {} });
    const corridor: RoomCombatState = {
      ...combat,
      map: { ...map, w: 8, h: 1, cells: [0, 8] },
      entities: combat.entities.map((entity) =>
        entity.id === 'ent_hero'
          ? { ...entity, pos: { x: 0, y: 0 } }
          : { ...entity, pos: { x: 2, y: 0 }, hidden: true },
      ),
    };
    room.state = {
      ...room.state,
      gameState: {
        combatRoom: corridor,
        combatActors: { [owner]: 'ent_hero' },
      },
    };
    await room.submitCombatCommand(owner, randomUUID(), {
      command: 'move',
      destination: { x: 3, y: 0 },
    });
    const latest = latestSnapshot();
    expect(events.some((event) => event.type === 'EntityRevealed')).toBe(true);
    const restarted = new Room(store, lease, { snapshot: latest, events: [] });
    expect(
      (
        restarted.state.gameState as { combatRoom: RoomCombatState }
      ).combatRoom.entities.find((entity) => entity.id === 'ent_goblin')
        ?.hidden,
    ).toBe(false);
    await room.drain();
  });

  it('accepts and persists a command submitted synchronously by NarrationCompleted delivery', async () => {
    const runner: SoloTurnRunner = {
      async run(_request, emit) {
        emit({ type: 'NarrationCompleted', narration: 'The turn ends.' });
        return {
          narration: 'The turn ends.',
          events: [{ type: 'TurnStarted', turnId: 'dm-turn' }],
          state: {},
          turnSeed: '0x0000000000000001',
          usage: { in: 1, out: 1 },
        };
      },
    };
    const { room, events, latestSnapshot } = setup(runner);
    const owner = randomUUID();
    let commandResult: Promise<boolean> | undefined;
    const commandActionId = randomUUID();
    let submitted!: (command: Promise<boolean>) => void;
    const commandSubmitted = new Promise<Promise<boolean>>((resolve) => {
      submitted = resolve;
    });
    await joinSeated(room, owner, {
      send(message) {
        if (message.type !== 'NarrationCompleted' || commandResult) return;
        commandResult = room.submitCombatCommand(owner, commandActionId, {
          command: 'move',
          destination: { x: 3, y: 1 },
        });
        submitted(commandResult);
      },
    });
    const initialCombat = {
      ...combat,
      phase: 'awaiting-command' as const,
      turnId: 'initial-turn',
    };
    room.state = {
      ...room.state,
      gameState: {
        combatRoom: initialCombat,
        combatActors: { [owner]: 'ent_hero' },
      },
    };

    await room.submitCombatCommand(owner, randomUUID(), {
      command: 'end-turn',
    });
    const submittedCommand = await commandSubmitted;
    expect(await submittedCommand).toBe(true);
    const internals = room as unknown as { activeTurn: Promise<void> };
    await internals.activeTurn;
    // If delivery preceded the worker's commit, the retry uses its original ID.
    await room.submitCombatCommand(owner, commandActionId, {
      command: 'move',
      destination: { x: 3, y: 1 },
    });

    expect(commandResult).toBeDefined();
    const saved = latestSnapshot()?.state as {
      gameState?: { combatRoom?: RoomCombatState };
    };
    expect(
      saved.gameState?.combatRoom?.entities.find(
        (entity) => entity.id === 'ent_hero',
      )?.pos,
    ).toEqual({ x: 3, y: 1 });
    expect(
      events.filter((event) => event.type === 'NarrationCompleted'),
    ).toHaveLength(1);
  });

  it('rejects actionable combat commands without deadlocking the mailbox while narration commits', async () => {
    const { room, events, latestSnapshot } = setup();
    const owner = randomUUID();
    const sent: { type: string; payload?: Record<string, unknown> }[] = [];
    await joinSeated(room, owner, {
      send: (message) => sent.push(message as never),
    });
    const eventsBeforeCommand = events.length;
    room.state = {
      ...room.state,
      gameState: {
        combatRoom: { ...combat, phase: 'awaiting-command' },
        combatActors: { [owner]: 'ent_hero' },
      },
    };
    let settle!: () => void;
    const settling = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const internals = room as unknown as {
      turnInFlight: boolean;
      activeTurn: Promise<void>;
    };
    internals.turnInFlight = true;
    internals.activeTurn = settling;

    const actionId = randomUUID();
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    await room.submitCombatCommand(owner, actionId, {
      command: 'attack',
      targetId: 'ent_goblin',
      attackId: 'sword',
    });
    expect(sent).toContainEqual(
      expect.objectContaining({
        type: 'Error',
        payload: expect.objectContaining({
          code: 'narration-in-progress',
          message: 'That attack is not currently available.',
          actionId,
        }),
      }),
    );
    expect(events).toHaveLength(eventsBeforeCommand);
    expect(log).toHaveBeenCalledWith(
      JSON.stringify({
        event: 'combat_attack_rejected',
        reason: 'narration_in_progress',
      }),
    );
    log.mockRestore();

    // The turn's continuation can now enqueue/commit through the mailbox.
    settle();
    internals.turnInFlight = false;
    await room.drain();
    expect(latestSnapshot()).toBeDefined();
  });

  it('uniformly rejects an attack when Room has no active combat', async () => {
    const { room } = setup();
    const owner = randomUUID();
    const sent: { type: string; payload?: Record<string, unknown> }[] = [];
    await joinSeated(room, owner, {
      send: (message) => sent.push(message as never),
    });
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    await room.submitCombatCommand(owner, randomUUID(), {
      command: 'attack',
      targetId: 'ent_goblin',
      attackId: 'sword',
    });
    expect(sent).toContainEqual(
      expect.objectContaining({
        type: 'Error',
        payload: expect.objectContaining({
          code: 'COMMAND_REJECTED',
          message: 'That attack is not currently available.',
        }),
      }),
    );
    expect(log).toHaveBeenCalledWith(
      JSON.stringify({
        event: 'combat_attack_rejected',
        reason: 'combat_inactive',
      }),
    );
    log.mockRestore();
  });

  it('continues rejecting commands while combat narration is genuinely in flight', async () => {
    const { room, events } = setup();
    const owner = randomUUID();
    const sent: { type: string; payload?: Record<string, unknown> }[] = [];
    await joinSeated(room, owner, {
      send: (message) => sent.push(message as never),
    });
    const eventsBeforeCommand = events.length;
    room.state = {
      ...room.state,
      gameState: {
        combatRoom: { ...combat, phase: 'narrating' },
        combatActors: { [owner]: 'ent_hero' },
      },
    };
    const internals = room as unknown as { turnInFlight: boolean };
    internals.turnInFlight = true;

    await room.submitCombatCommand(owner, randomUUID(), {
      command: 'move',
      destination: { x: 3, y: 1 },
    });

    expect(sent).toContainEqual(
      expect.objectContaining({
        type: 'Error',
        payload: expect.objectContaining({
          code: 'narration-in-progress',
          message: 'The DM is narrating this turn.',
        }),
      }),
    );
    expect(events).toHaveLength(eventsBeforeCommand);
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
    });
    expect(valid).not.toHaveProperty('code');
    if (!('code' in valid))
      expect(valid.events.map((event) => event.type)).toEqual([
        'MoveStarted',
        'EntityMoved',
        'MoveEnded',
      ]);
    if (!('code' in valid))
      expect(valid.events.at(-1)).toMatchObject({
        type: 'MoveEnded',
        reason: 'complete',
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

  it('uses one rejection message for every unavailable or illegal attack', () => {
    const runtime = createCombatRuntime();
    const command = {
      command: 'attack' as const,
      targetId: 'ent_goblin',
      attackId: 'sword',
    };
    const cases: Array<[string, RoomCombatState, typeof command]> = [
      ['missing target', combat, { ...command, targetId: 'missing' }],
      [
        'dead target',
        {
          ...combat,
          entities: combat.entities.map((e) =>
            e.id === 'ent_goblin' ? { ...e, hp: 0 } : e,
          ),
        },
        command,
      ],
      [
        'fled target',
        {
          ...combat,
          entities: combat.entities.map((e) =>
            e.id === 'ent_goblin' ? { ...e, fled: true } : e,
          ),
        },
        command,
      ],
      ['missing weapon', combat, { ...command, attackId: 'missing' }],
      [
        'missing action',
        {
          ...combat,
          combat: {
            ...combat.combat,
            resources: {
              ...combat.combat.resources,
              ent_hero: { ...combat.combat.resources.ent_hero!, action: false },
            },
          },
        },
        command,
      ],
      ['out of reach', combat, command],
    ];
    const results = cases.map((attackCase) =>
      runtime.execute(attackCase[1], 'ent_hero', attackCase[2]),
    );
    expect(
      results.map((result) => ('code' in result ? result.message : null)),
    ).toEqual(cases.map(() => 'That attack is not currently available.'));
    expect(
      results.map((result) =>
        'code' in result ? result.attackRejectReason : null,
      ),
    ).toEqual([
      'target_unavailable',
      'target_dead',
      'target_fled',
      'weapon_missing',
      'action_unavailable',
      'illegal_range_or_line_of_sight',
    ]);
  });

  it('treats a hidden target id as nonexistent to a viewer who does not control it', () => {
    const runtime = createCombatRuntime();
    const hidden: RoomCombatState = {
      ...combat,
      entities: combat.entities.map((entity) =>
        entity.id === 'ent_goblin'
          ? { ...entity, hidden: true, pos: { x: 2, y: 1 }, ac: 10 }
          : entity,
      ),
    };
    const result = runtime.execute(hidden, 'ent_hero', {
      command: 'attack',
      targetId: 'ent_goblin',
      attackId: 'sword',
    });
    expect(result).toMatchObject({
      code: 'COMMAND_REJECTED',
      message: 'That attack is not currently available.',
    });
    if ('code' in result) {
      expect(result).not.toHaveProperty('events');
      expect(result.attackRejectReason).toBe('target_unavailable');
    }
    expect(hidden.combat.resources.ent_hero?.action).toBe(true);
    const controlled = runtime.execute(
      hidden,
      'ent_hero',
      {
        command: 'attack',
        targetId: 'ent_goblin',
        attackId: 'sword',
      },
      { controlledEntityIds: new Set(['ent_goblin']) },
    );
    expect(controlled).not.toMatchObject({ code: 'COMMAND_REJECTED' });
  });

  it('keeps the active token first and hides exact enemy HP in the tracker', () => {
    const tracker = combatTracker(combat);
    expect(tracker.activeEntityId).toBe(combat.combat.initiative[0]?.entityId);
    expect(tracker.entities[0]).toMatchObject({ id: 'ent_hero', hp: 12 });
    expect(tracker.entities[0]).toHaveProperty('maxHp', 12);
    expect(tracker.entities[1]).toMatchObject({
      id: 'ent_goblin',
      hpState: 'healthy',
    });
    expect(tracker.entities[1]).not.toHaveProperty('hp');
    expect(tracker.entities[1]).not.toHaveProperty('maxHp');
  });
});
