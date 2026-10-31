import { afterEach, describe, expect, it, vi } from 'vitest';
import { BattlemapSchema, rleEncode, type Battlemap } from '@game/schema';
import { loadAuthoredMap } from '@game/rules-engine';
import {
  combatTracker,
  combatOpeningSummary,
  projectCombatForViewer,
  REACTION_TIMEOUT_MS,
  type RoomCombatState,
} from '../../src/room/combat.js';
import {
  account,
  bootstrapped,
  catalog,
  cryptMap,
  hero,
  memoryTable,
  partyCombat,
  placed,
} from './combatFixtures.js';
import { joinSeated } from '../helpers/room.js';
import { carryPromptSeq, promptIdOf } from '../../src/room/combatTypes.js';
import { answerReaction, settle } from '../../src/room/combatEngine.js';
import { projectEventForViewer } from '../../src/room/eventVisibility.js';

afterEach(() => vi.useRealTimers());

const NOW = 1_000_000;
const types = (events: readonly Record<string, unknown>[]) =>
  events.map((event) => String(event.type));
const expectBalancedMovement = (
  events: readonly Record<string, unknown>[],
  paused: readonly string[] = [],
) => {
  const open = new Set<string>();
  for (const event of events) {
    if (event.type === 'MoveStarted') {
      const id = String(event.entityId);
      expect(open.has(id), `nested movement for ${id}`).toBe(false);
      open.add(id);
    } else if (event.type === 'MoveEnded') {
      const id = String(event.entityId);
      expect(open.has(id), `orphan MoveEnded for ${id}`).toBe(true);
      open.delete(id);
    }
  }
  expect([...open].sort()).toEqual([...paused].sort());
};
const ok = <T extends object>(value: T | { code: string }) => {
  if ('code' in value) throw new Error(`rejected: ${value.code}`);
  return value;
};
/** The hero beside a goblin, the other goblin far away, so leaving the first provokes exactly one reaction. */
function engaged() {
  const b = bootstrapped();
  const state = placed(b.state, {
    ent_aria: { x: 7, y: 2 },
    'ent_goblin-minion_1': { x: 8, y: 2 },
    'ent_goblin-minion_2': { x: 12, y: 16 },
  });
  return { ...b, state };
}

/** An authored map from rows of '.' (floor) and '#' (stone wall), palette-compatible with the crypt room. */
function mapFrom(rows: string[]): Battlemap {
  const grid = rows.flatMap((row) => [...row].map((c) => (c === '#' ? 3 : 0)));
  const loaded = loadAuthoredMap(
    BattlemapSchema.parse({
      mapId: 'hidden-route-fixture',
      w: rows[0]!.length,
      h: rows.length,
      palette: cryptMap.palette,
      cells: rleEncode(grid),
      edges: [],
      features: [],
      markers: [],
      zones: [],
      diagonalRule: '5ft',
    }),
  );
  if (!loaded.ok) throw new Error('hidden-route fixture map failed validation');
  return loaded.map;
}

describe('combat bootstrap from the DM start_combat result', () => {
  it('builds the moderation fallback summary from the viewer projection', () => {
    const { state } = bootstrapped();
    const hidden = state.entities.filter((entity) => entity.team === 'enemies');
    const hiddenIds = hidden.map((entity) => entity.id);
    const summary = combatOpeningSummary({
      ...state,
      entities: state.entities.map((entity) =>
        hiddenIds.includes(entity.id) ? { ...entity, hidden: true } : entity,
      ),
    });
    expect(summary).toContain('Combat begins.');
    for (const entity of hidden) {
      expect(summary).not.toContain(entity.id);
      expect(summary).not.toContain(`${entity.pos.x}, ${entity.pos.y}`);
    }
    expect(summary).toContain('initiative');
  });

  it('projects the held-opening summary and CombatStarted list to the same controller', () => {
    const { state, events } = bootstrapped();
    const hiddenId = 'ent_goblin-minion_1';
    const hiddenState = {
      ...state,
      entities: state.entities.map((entity) =>
        entity.id === hiddenId ? { ...entity, hidden: true } : entity,
      ),
    };
    const started = events.find((event) => event.type === 'CombatStarted')!;
    const noControl = projectEventForViewer(
      started,
      new Set([hiddenId]),
      new Set(),
    )!;
    const controller = projectEventForViewer(
      started,
      new Set([hiddenId]),
      new Set([hiddenId]),
    )!;
    const ordinarySummary = combatOpeningSummary(hiddenState);
    const controllerSummary = combatOpeningSummary(
      hiddenState,
      new Set([hiddenId]),
    );
    expect(JSON.stringify(noControl)).not.toContain(hiddenId);
    expect(ordinarySummary).not.toContain(hiddenId);
    expect(JSON.stringify(controller)).toContain(hiddenId);
    expect(controllerSummary).toContain(
      hiddenState.entities.find((e) => e.id === hiddenId)!.name,
    );
  });

  it('places the party and monsters on the structured map with initiative and the active turn', () => {
    const { state, game, events } = bootstrapped();
    const party = state.entities.find((e) => e.id === 'ent_aria')!;
    expect(party.pos).toEqual({ x: 7, y: 2 });
    const foes = state.entities.filter((e) => e.team === 'enemies');
    expect(foes).toHaveLength(2);
    for (const foe of foes) {
      expect(foe.pos.y).toBeGreaterThanOrEqual(16);
      expect(foe.attacks?.[0]?.attackBonus).toBe(4);
    }
    expect(state.combat.initiative.map((i) => i.entityId).sort()).toEqual(
      state.entities.map((e) => e.id).sort(),
    );
    expect(state.combat.activeEntityId).toBe(
      state.combat.initiative[0]?.entityId,
    );
    expect((game as { combatActors: object }).combatActors).toEqual({
      [account]: 'ent_aria',
    });
    expect(types(events)).toEqual(['CombatStarted', 'TurnStarted']);
  });

  it('runs leading monster turns before handing control to the party', () => {
    const { runtime } = bootstrapped();
    const rec = runtime.reconcile(
      (() => {
        const first = bootstrapped();
        const game = first.game as {
          gameEngine: { combat: { initiative: { entityId: string }[] } };
        };
        // Put a goblin at the head of initiative.
        game.gameEngine.combat.initiative = [
          ...game.gameEngine.combat.initiative,
        ].sort((a) => (a.entityId === 'ent_aria' ? 1 : -1));
        const rest = { ...(first.game as Record<string, unknown>) };
        delete rest.combatRoom;
        return rest;
      })(),
      NOW,
    )!;
    const room = (rec.gameState as { combatRoom: RoomCombatState }).combatRoom;
    expect(room.combat.activeEntityId).toBe('ent_aria');
    expect(types(rec.events)).toContain('MonsterPolicy');
  });

  it('clears the Room combat when the DM ends combat', () => {
    const { runtime, game } = bootstrapped();
    const engine = (game as { gameEngine: Record<string, unknown> }).gameEngine;
    const ended = runtime.reconcile(
      {
        ...(game as object),
        gameEngine: {
          ...engine,
          combat: { ...(engine.combat as object), initiative: [] },
        },
      },
      NOW,
    )!;
    expect(ended.gameState).not.toHaveProperty('combatRoom');
    expect(types(ended.events)).toEqual(['CombatEnded']);
  });
});

describe('monster morale', () => {
  it('ends combat cleanly when the last goblin flees at one-quarter HP', () => {
    const { runtime, state } = engaged();
    const initiative = [
      { entityId: 'ent_aria', total: 20 },
      { entityId: 'ent_goblin-minion_1', total: 10 },
      { entityId: 'ent_goblin-minion_2', total: 5 },
    ];
    const lowMorale = {
      ...state,
      entities: state.entities.map((entity) =>
        entity.id === 'ent_goblin-minion_1'
          ? { ...entity, hp: 1 }
          : entity.id === 'ent_goblin-minion_2'
            ? { ...entity, hp: 0 }
            : entity,
      ),
      combat: {
        ...state.combat,
        initiative,
        activeEntityId: 'ent_aria',
      },
    };

    const result = ok(
      runtime.execute(
        lowMorale,
        'ent_aria',
        { command: 'end-turn' },
        { now: NOW },
      ),
    );

    expect(result.state.ended?.outcome).toBe('enemies-fled');
    expect(types(result.events)).toContain('MonsterPolicy');
    expect(types(result.events)).toContain('CombatEnded');
  });
});

describe('tracker', () => {
  it('clears a stale reaction phase when combat ends during a reaction', () => {
    const { state } = bootstrapped();
    const pending = {
      reactionId: 'reaction-1',
      entityId: 'ent_goblin-minion_1',
      trigger: 'opportunityAttack' as const,
      moverId: 'ent_aria',
      deadlineAt: NOW + 15_000,
    };
    const ending: RoomCombatState = {
      ...state,
      phase: 'reaction-pending',
      pendingReaction: pending,
      entities: state.entities.map((entity) =>
        entity.team === 'enemies' ? { ...entity, hp: 0 } : entity,
      ),
    };

    const result = settle(ending);

    expect(result.state.ended?.outcome).toBe('party-victory');
    expect(result.state.pendingReaction).toBeUndefined();
    expect(result.state.phase).toBe('awaiting-command');
  });

  it.each([
    [
      'victory',
      (entity: RoomCombatState['entities'][number]) =>
        entity.team === 'enemies' ? { ...entity, hp: 0 } : entity,
      'party-victory',
    ],
    [
      'defeat',
      (entity: RoomCombatState['entities'][number]) =>
        entity.team === 'party' ? { ...entity, hp: 0 } : entity,
      'party-defeated',
    ],
    [
      'flee',
      (entity: RoomCombatState['entities'][number]) =>
        entity.team === 'enemies' ? { ...entity, fled: true } : entity,
      'enemies-fled',
    ],
  ] as const)(
    'settles authored encounter combat on %s without an early reward event',
    (_label, changeEntity, outcome) => {
      const { state } = bootstrapped();
      const settled = settle({
        ...state,
        entities: state.entities.map(changeEntity),
      });
      expect(settled.state.ended?.outcome).toBe(outcome);
      expect(
        settled.events.some((event) =>
          /Xp|Loot|Reward/u.test(String(event.type)),
        ),
      ).toBe(false);
    },
  );

  it('terminates an open move when CombatEnded closes the encounter', () => {
    const e = engaged();
    const moving = ok(
      e.runtime.execute(
        e.state,
        'ent_aria',
        { command: 'move', destination: { x: 7, y: 6 } },
        { now: NOW },
      ),
    );
    expect(moving.state.pendingReaction).toBeDefined();
    const ended = settle({
      ...moving.state,
      entities: moving.state.entities.map((entity) =>
        entity.team === 'enemies' ? { ...entity, hp: 0 } : entity,
      ),
    });

    expectBalancedMovement([...moving.events, ...ended.events]);
    expect(types(ended.events)).toContain('CombatEnded');
  });

  it('does not expose the internal phase in the client projection', () => {
    const { state } = bootstrapped();
    expect(combatTracker(state)).not.toHaveProperty('phase');
    expect(
      combatTracker({ ...state, phase: 'reaction-pending' }),
    ).not.toHaveProperty('phase');
  });

  it('property: the highlighted token is always the first initiative entry, for any turn position', () => {
    const { state } = bootstrapped();
    let rng = 12345;
    const next = () => (rng = (rng * 1103515245 + 12345) & 0x7fffffff);
    for (let i = 0; i < 300; i++) {
      const size = 1 + (next() % 6);
      const entries = Array.from({ length: size }, (_, n) => ({
        entityId: `ent_${n}`,
        total: next() % 30,
      }));
      const active = entries[next() % size]!.entityId;
      const tracker = combatTracker({
        ...state,
        entities: entries.map((e) => ({
          ...state.entities[0]!,
          id: e.entityId,
          team: next() % 2 ? 'party' : 'enemies',
        })),
        combat: {
          ...state.combat,
          initiative: entries,
          activeEntityId: active,
        },
      });
      expect(tracker.activeEntityId).toBe(active);
      expect(tracker.initiative[0]?.entityId).toBe(tracker.activeEntityId);
      expect(tracker.initiative).toHaveLength(size);
    }
  });
});

describe('player commands', () => {
  it.each([
    ['awaiting-command', 'active', 'end-turn', undefined],
    ['awaiting-command', 'other', 'end-turn', 'not-your-turn'],
    ['moving', 'active', 'end-turn', 'move-in-progress'],
    ['moving', 'other', 'end-turn', 'not-your-turn'],
    ['moving', 'other', 'reaction', 'not-your-turn'],
    ['reaction-pending', 'active', 'end-turn', 'reaction-window-open'],
    ['reaction-pending', 'reactor', 'end-turn', 'not-your-turn'],
    ['reaction-pending', 'other', 'end-turn', 'not-your-turn'],
    ['reaction-pending', 'reactor', 'reaction', undefined],
    ['reaction-pending', 'mover', 'reaction', 'not-your-turn'],
    ['reaction-pending', 'active', 'reaction', 'not-your-turn'],
    ['reaction-pending', 'other', 'reaction', 'not-your-turn'],
    ['narrating', 'active', 'end-turn', 'narration-in-progress'],
    ['narrating', 'other', 'end-turn', 'not-your-turn'],
    ['narrating', 'other', 'reaction', 'not-your-turn'],
  ] as const)(
    'admits %s phase / %s seat / %s according to authorization-first precedence',
    (phase, role, kind, expectedCode) => {
      const { runtime, state } = engaged();
      const actorId =
        role === 'active'
          ? state.combat.activeEntityId!
          : role === 'reactor'
            ? 'ent_goblin-minion_1'
            : role === 'mover'
              ? 'ent_aria'
              : 'ent_goblin-minion_2';
      const phased: RoomCombatState = {
        ...state,
        phase,
        ...(phase === 'reaction-pending'
          ? {
              pendingReaction: {
                reactionId: 'reaction-1',
                entityId: 'ent_goblin-minion_1',
                trigger: 'opportunityAttack',
                moverId: 'ent_aria',
                deadlineAt: NOW + 15_000,
              },
            }
          : {}),
      };
      const result = runtime.execute(
        phased,
        actorId,
        kind === 'reaction'
          ? { command: 'reaction', reactionId: 'reaction-1', choice: 'decline' }
          : { command: 'end-turn' },
        { now: NOW },
      );
      if (expectedCode) {
        expect(result).toMatchObject({ code: expectedCode });
        if (expectedCode === 'not-your-turn')
          expect(result).toMatchObject({ message: 'It is not your turn.' });
      } else
        expect(result).not.toMatchObject({
          code: expect.stringMatching(
            /not-your-turn|move-in-progress|reaction-window-open|narration-in-progress/,
          ),
        });
    },
  );

  it('treats a pending reaction as authoritative over a stale awaiting-command phase', () => {
    const { runtime, state } = engaged();
    const pending = {
      reactionId: 'reaction-1',
      entityId: 'ent_goblin-minion_1',
      trigger: 'opportunityAttack',
      moverId: 'ent_aria',
      deadlineAt: NOW + 15_000,
    };
    const result = runtime.execute(
      { ...state, phase: 'awaiting-command', pendingReaction: pending },
      'ent_goblin-minion_1',
      { command: 'reaction', reactionId: 'reaction-1', choice: 'decline' },
      { now: NOW },
    );
    expect(result).not.toMatchObject({ code: 'reaction-window-open' });
    expect(result).not.toMatchObject({ code: 'not-your-turn' });
  });

  it('rejects illegal commands and leaves the state untouched', () => {
    const { runtime, state } = engaged();
    const before = structuredClone(state);
    const hero_ = (command: Parameters<typeof runtime.execute>[2]) =>
      runtime.execute(state, 'ent_aria', command, {
        character: hero,
        now: NOW,
      });
    expect(
      runtime.execute(state, 'ent_goblin-minion_1', { command: 'end-turn' }),
    ).toMatchObject({ code: 'not-your-turn' });
    expect(
      hero_({
        command: 'attack',
        targetId: 'ent_goblin-minion_2',
        attackId: 'staff',
      }),
    ).toMatchObject({ code: 'COMMAND_REJECTED' });
    expect(
      hero_({
        command: 'attack',
        targetId: 'ent_goblin-minion_1',
        attackId: 'vorpal',
      }),
    ).toMatchObject({ code: 'COMMAND_REJECTED' });
    expect(
      hero_({ command: 'move', destination: { x: 0, y: 0 } }),
    ).toMatchObject({ code: 'COMMAND_REJECTED' });
    expect(
      hero_({
        command: 'cast',
        spellId: 'spell:fireball',
        slotLevel: 3,
        target: { kind: 'self' },
      }),
    ).toMatchObject({ code: 'COMMAND_REJECTED' });
    expect(
      hero_({
        command: 'cast',
        spellId: 'spell:burning-hands',
        slotLevel: 1,
        target: { kind: 'option', ref: 'area:made-up' },
      }),
    ).toMatchObject({ code: 'COMMAND_REJECTED' });
    expect(
      hero_({ command: 'reaction', reactionId: 'nothing', choice: 'take' }),
    ).toMatchObject({ code: 'not-your-turn' });
    expect(state).toEqual(before);
  });

  it('casts an area spell aimed through the engine options and writes slots back', () => {
    const { runtime, state } = engaged();
    const adjacent = placed(state, {
      'ent_goblin-minion_2': { x: 9, y: 2 },
    });
    const options = ok(
      runtime.execute(
        adjacent,
        'ent_aria',
        { command: 'options' },
        { character: hero },
      ),
    );
    const areas = (
      options.messages![0]!.payload as {
        areas: {
          optionId: string;
          spellId: string;
          affected: { id: string; relation: string }[];
        }[];
      }
    ).areas;
    const best = areas
      .filter((a) => a.spellId === 'spell:burning-hands')
      .sort((a, b) => b.affected.length - a.affected.length)[0]!;
    expect(best.affected.map((a) => a.id)).toEqual(
      expect.arrayContaining(['ent_goblin-minion_1', 'ent_goblin-minion_2']),
    );
    expect(best.affected.every((a) => a.relation === 'enemy')).toBe(true);
    const cast = ok(
      runtime.execute(
        adjacent,
        'ent_aria',
        {
          command: 'cast',
          spellId: 'spell:burning-hands',
          slotLevel: 1,
          target: { kind: 'option', ref: best.optionId },
        },
        { character: hero, now: NOW },
      ),
    );
    expect(types(cast.events)).toEqual(
      expect.arrayContaining(['SlotSpent', 'SpellCast', 'AreaResolved']),
    );
    const area = cast.events.find((e) => e.type === 'AreaResolved') as {
      affected: string[];
    };
    expect(area.affected).toEqual(
      expect.arrayContaining(['ent_goblin-minion_1', 'ent_goblin-minion_2']),
    );
    expect(cast.slots).toEqual({
      entityId: 'ent_aria',
      slots: { '1': { max: 2, used: 1 } },
    });
    expect(cast.state.combat.resources.ent_aria?.action).toBe(false);
    // the engine, not the client, applied the damage
    expect(
      cast.state.entities.some((e) => e.team === 'enemies' && e.hp < 7),
    ).toBe(true);
    // action is spent: a second cast this turn is refused
    expect(
      runtime.execute(
        cast.state,
        'ent_aria',
        {
          command: 'cast',
          spellId: 'spell:burning-hands',
          slotLevel: 1,
          target: { kind: 'option', ref: best.optionId },
        },
        { character: hero, now: NOW },
      ),
    ).toMatchObject({ code: 'COMMAND_REJECTED' });
  });
});

describe('hidden spell targets and options', () => {
  const fireBoltCaster = {
    ...hero,
    spellsKnown: ['spell:fire-bolt'],
    spellsPrepared: ['spell:fire-bolt', 'spell:fireball'],
    slots: { ...hero.slots, '3': { max: 1, used: 0 } },
  };

  it('normalizes combat-ended and not-your-turn attack admissions', () => {
    const { runtime, state } = engaged();
    const attack = {
      command: 'attack' as const,
      targetId: 'missing',
      attackId: 'staff',
    };
    expect(
      runtime.execute(
        { ...state, ended: { outcome: 'victory' } },
        'ent_aria',
        attack,
      ),
    ).toMatchObject({
      code: 'COMMAND_REJECTED',
      message: 'That attack is not currently available.',
      attackRejectReason: 'combat_ended',
    });
    expect(runtime.execute(state, 'ent_goblin-minion_1', attack)).toMatchObject(
      {
        code: 'not-your-turn',
        message: 'That attack is not currently available.',
        attackRejectReason: 'not_your_turn',
      },
    );
  });

  it('treats hidden, dead, fled, and nonexistent entity targets alike', () => {
    const { runtime, state } = engaged();
    const hidden = placed(state, { 'ent_goblin-minion_1': { x: 3, y: 2 } });
    hidden.entities = hidden.entities.map((entity) =>
      entity.id === 'ent_goblin-minion_1'
        ? { ...entity, hidden: true }
        : entity,
    );
    const dead = {
      ...state,
      entities: state.entities.map((entity) =>
        entity.id === 'ent_goblin-minion_1' ? { ...entity, hp: 0 } : entity,
      ),
    };
    const fled = {
      ...state,
      entities: state.entities.map((entity) =>
        entity.id === 'ent_goblin-minion_1'
          ? { ...entity, fled: true }
          : entity,
      ),
    };
    const command = (ref: string) => ({
      command: 'cast' as const,
      spellId: 'spell:fire-bolt',
      slotLevel: 0,
      target: { kind: 'entity' as const, ref },
    });
    const results = [
      runtime.execute(hidden, 'ent_aria', command('ent_goblin-minion_1'), {
        character: fireBoltCaster,
      }),
      runtime.execute(state, 'ent_aria', command('missing'), {
        character: fireBoltCaster,
      }),
      runtime.execute(dead, 'ent_aria', command('ent_goblin-minion_1'), {
        character: fireBoltCaster,
      }),
      runtime.execute(fled, 'ent_aria', command('ent_goblin-minion_1'), {
        character: fireBoltCaster,
      }),
    ];
    expect(
      results.map((result) => ('code' in result ? result.message : null)),
    ).toEqual(Array(4).fill('That target is not on the map.'));
    expect(
      runtime.execute(hidden, 'ent_aria', command('ent_goblin-minion_1'), {
        character: fireBoltCaster,
        controlledEntityIds: new Set(['ent_goblin-minion_1']),
      }),
    ).not.toMatchObject({ code: 'COMMAND_REJECTED' });
  });

  it('omits hidden ids and anchors from options, matching the removed-entity payload', () => {
    const { runtime, state } = engaged();
    const hidden = placed(state, { 'ent_goblin-minion_1': { x: 3, y: 2 } });
    hidden.entities = hidden.entities.map((entity) =>
      entity.id === 'ent_goblin-minion_1'
        ? { ...entity, hidden: true }
        : entity,
    );
    const context = { character: fireBoltCaster };
    const hiddenOptions = ok(
      runtime.execute(hidden, 'ent_aria', { command: 'options' }, context),
    );
    const payload = hiddenOptions.messages![0]!.payload;
    const removedOptions = ok(
      runtime.execute(
        {
          ...hidden,
          entities: hidden.entities.filter(
            (entity) => entity.id !== 'ent_goblin-minion_1',
          ),
        },
        'ent_aria',
        { command: 'options' },
        context,
      ),
    );
    expect(payload).toEqual(removedOptions.messages![0]!.payload);
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain('ent_goblin-minion_1');
    expect(
      (payload.areas as { anchor: { x: number; y: number } }[]).some(
        (area) => area.anchor.x === 3 && area.anchor.y === 2,
      ),
    ).toBe(false);
  });

  it("keeps the acting seat's area-spell events and state identical when hidden fills an empty cell", () => {
    const { runtime, state } = engaged();
    const hiddenId = 'ent_goblin-minion_1';
    const hidden = placed(state, {
      ent_aria: { x: 7, y: 2 },
      [hiddenId]: { x: 8, y: 2 },
      'ent_goblin-minion_2': { x: 12, y: 16 },
    });
    hidden.entities = hidden.entities.map((entity) =>
      entity.id === hiddenId ? { ...entity, hidden: true } : entity,
    );
    const empty = {
      ...hidden,
      entities: hidden.entities.map((entity) =>
        entity.id === hiddenId ? { ...entity, pos: { x: 2, y: 12 } } : entity,
      ),
    };
    const castAt = (combat: RoomCombatState) =>
      ok(
        runtime.execute(
          combat,
          'ent_aria',
          {
            command: 'cast',
            spellId: 'spell:fireball',
            slotLevel: 3,
            target: { kind: 'anchor', ref: '7,2' },
          },
          { character: fireBoltCaster },
        ),
      );
    const hiddenCast = castAt(hidden);
    const emptyCast = castAt(empty);
    const hiddenIds = new Set([hiddenId]);
    const visible = (events: readonly Record<string, unknown>[]) =>
      events
        .map((event) =>
          projectEventForViewer(event, hiddenIds, new Set(['ent_aria'])),
        )
        .filter((event) => event !== null);

    expect(
      hiddenCast.events.some(
        (event) => event.type === 'HpChanged' && event.entityId === hiddenId,
      ),
    ).toBe(true);
    expect(visible(hiddenCast.events)).toEqual(visible(emptyCast.events));
    expect(
      projectCombatForViewer(hiddenCast.state, new Set(['ent_aria'])),
    ).toEqual(projectCombatForViewer(emptyCast.state, new Set(['ent_aria'])));
  });

  it('rejects area aim on a hidden cell like an empty cell or nonexistent option', () => {
    const { runtime, state } = engaged();
    const hidden = placed(state, { 'ent_goblin-minion_1': { x: 3, y: 2 } });
    hidden.entities = hidden.entities.map((entity) =>
      entity.id === 'ent_goblin-minion_1'
        ? { ...entity, hidden: true }
        : entity,
    );
    const context = { character: fireBoltCaster };
    const castAt = (
      combat: RoomCombatState,
      target: { kind: 'anchor' | 'option'; ref: string },
    ) =>
      runtime.execute(
        combat,
        'ent_aria',
        {
          command: 'cast',
          spellId: 'spell:fireball',
          slotLevel: 3,
          target,
        },
        context,
      );
    const hiddenAim = castAt(hidden, { kind: 'anchor', ref: '3,2' });
    const emptyAim = castAt(state, { kind: 'anchor', ref: '3,2' });
    const nonexistentOption = castAt(hidden, {
      kind: 'option',
      ref: 'area:missing',
    });
    expect(hiddenAim).toMatchObject({ code: 'COMMAND_REJECTED' });
    expect(emptyAim).toMatchObject({ code: 'COMMAND_REJECTED' });
    expect('code' in hiddenAim && hiddenAim.message).toBe(
      'code' in emptyAim ? emptyAim.message : undefined,
    );
    expect('code' in nonexistentOption && nonexistentOption.message).toBe(
      'code' in hiddenAim ? hiddenAim.message : undefined,
    );
  });
});

describe('action economy for spells', () => {
  const healer = {
    ...hero,
    spellsKnown: ['spell:expeditious-retreat'],
    spellsPrepared: ['spell:expeditious-retreat'],
  };
  const withSpent = (
    state: RoomCombatState,
    spent: 'action' | 'bonusAction',
  ): RoomCombatState => ({
    ...state,
    combat: {
      ...state.combat,
      resources: {
        ...state.combat.resources,
        ent_aria: { ...state.combat.resources.ent_aria!, [spent]: false },
      },
    },
  });
  const healSelf = {
    command: 'cast',
    spellId: 'spell:expeditious-retreat',
    slotLevel: 1,
    target: { kind: 'entity', ref: 'ent_aria' },
  } as const;

  it('spends only the bonus action for a bonus-action spell', () => {
    const { runtime, state } = engaged();
    const cast = ok(
      runtime.execute(state, 'ent_aria', healSelf, {
        character: healer,
        now: NOW,
      }),
    );
    expect(cast.state.combat.resources.ent_aria?.bonusAction).toBe(false);
    expect(cast.state.combat.resources.ent_aria?.bonusActionSpellCast).toBe(
      true,
    );
    expect(cast.state.combat.resources.ent_aria?.action).toBe(true);
    expect(types(cast.events)).toContain('BonusActionSpent');
  });

  it('refuses a bonus-action spell once the bonus action is spent', () => {
    const { runtime, state } = engaged();
    expect(
      runtime.execute(withSpent(state, 'bonusAction'), 'ent_aria', healSelf, {
        character: healer,
        now: NOW,
      }),
    ).toMatchObject({ code: 'COMMAND_REJECTED' });
  });

  it('refuses an action spell when only the bonus action is left', () => {
    const { runtime, state } = engaged();
    expect(
      runtime.execute(
        withSpent(state, 'action'),
        'ent_aria',
        {
          command: 'cast',
          spellId: 'spell:burning-hands',
          slotLevel: 1,
          target: { kind: 'self' },
        },
        { character: hero, now: NOW },
      ),
    ).toMatchObject({ code: 'COMMAND_REJECTED' });
  });

  it('refuses an action spell after a bonus-action spell', () => {
    const { runtime, state } = engaged();
    const castBonus = ok(
      runtime.execute(state, 'ent_aria', healSelf, {
        character: healer,
        now: NOW,
      }),
    );
    expect(
      runtime.execute(
        castBonus.state,
        'ent_aria',
        {
          command: 'cast',
          spellId: 'spell:burning-hands',
          slotLevel: 1,
          target: { kind: 'self' },
        },
        { character: hero, now: NOW },
      ),
    ).toMatchObject({ code: 'COMMAND_REJECTED' });
  });

  it('allows an action spell after a non-spell bonus action', () => {
    const { runtime, state } = engaged();
    const result = runtime.execute(
      withSpent(state, 'bonusAction'),
      'ent_aria',
      {
        command: 'cast',
        spellId: 'spell:burning-hands',
        slotLevel: 1,
        target: { kind: 'self' },
      },
      { character: hero, now: NOW },
    );
    expect(result).not.toMatchObject({ code: 'COMMAND_REJECTED' });
  });

  it('allows an action cantrip after a bonus-action spell', () => {
    const { runtime, state } = engaged();
    const castBonus = ok(
      runtime.execute(state, 'ent_aria', healSelf, {
        character: healer,
        now: NOW,
      }),
    );
    const cantripCaster = {
      ...hero,
      spellsKnown: ['spell:fire-bolt'],
      spellsPrepared: ['spell:fire-bolt'],
    };
    expect(
      runtime.execute(
        castBonus.state,
        'ent_aria',
        {
          command: 'cast',
          spellId: 'spell:fire-bolt',
          slotLevel: 0,
          target: { kind: 'entity', ref: 'ent_goblin-minion_1' },
        },
        { character: cantripCaster, now: NOW },
      ),
    ).not.toMatchObject({ code: 'COMMAND_REJECTED' });
  });

  it('refuses a second bonus-action spell in the same turn', () => {
    const { runtime, state } = engaged();
    const castBonus = ok(
      runtime.execute(state, 'ent_aria', healSelf, {
        character: healer,
        now: NOW,
      }),
    );
    expect(
      runtime.execute(castBonus.state, 'ent_aria', healSelf, {
        character: healer,
        now: NOW,
      }),
    ).toMatchObject({ code: 'COMMAND_REJECTED' });
  });
});

describe('opportunity attack reactions', () => {
  const leave = { command: 'move', destination: { x: 7, y: 6 } } as const;
  it('balances an uninterrupted move', () => {
    const { runtime, state } = engaged();
    const moved = ok(
      runtime.execute(
        state,
        'ent_aria',
        { command: 'move', destination: { x: 7, y: 3 } },
        { now: NOW },
      ),
    );
    expectBalancedMovement(moved.events);
  });

  const provoke = () => {
    const e = engaged();
    const moved = ok(
      e.runtime.execute(e.state, 'ent_aria', leave, { now: NOW }),
    );
    return { ...e, moved };
  };

  it('pauses the move and prompts with a deadline 15 s out', () => {
    const { moved } = provoke();
    expect(types(moved.events)).toEqual(
      expect.arrayContaining(['OpportunityTriggered', 'ReactionAvailable']),
    );
    const prompt = moved.state.pendingReaction!;
    expect(prompt).toMatchObject({
      entityId: 'ent_goblin-minion_1',
      moverId: 'ent_aria',
      deadlineAt: NOW + REACTION_TIMEOUT_MS,
    });
    expect(
      moved.state.entities.find((e) => e.id === 'ent_aria')!.pos,
    ).not.toEqual({
      x: 7,
      y: 6,
    });
    expect(types(moved.events)).toContain('MoveStarted');
    expect(types(moved.events)).not.toContain('MoveEnded');
    expect(moved.events.filter((e) => e.type === 'MoveStarted')).toEqual([
      expect.objectContaining({ type: 'MoveStarted', entityId: 'ent_aria' }),
    ]);
    expect(moved.state.phase).toBe('reaction-pending');
    expectBalancedMovement(moved.events, ['ent_aria']);
  });

  it('refuses every other command while the prompt is open', () => {
    const { runtime, moved } = provoke();
    expect(
      runtime.execute(moved.state, 'ent_aria', { command: 'end-turn' }),
    ).toMatchObject({ code: 'reaction-window-open' });
  });

  it('accept: the goblin spends its reaction on an engine-resolved attack and the move continues', () => {
    const { runtime, moved } = provoke();
    const taken = ok(
      runtime.execute(
        moved.state,
        'ent_goblin-minion_1',
        {
          command: 'reaction',
          reactionId: moved.state.pendingReaction!.reactionId,
          choice: 'take',
        },
        { now: NOW + 1000 },
      ),
    );
    expect(types(taken.events)).toEqual(
      expect.arrayContaining([
        'ReactionResolved',
        'ReactionSpent',
        'RollEvent',
      ]),
    );
    expect(
      taken.events.find((e) => e.type === 'ReactionResolved'),
    ).toMatchObject({
      used: true,
    });
    expect(taken.state.pendingReaction).toBeUndefined();
    expect(types(taken.events)).not.toContain('MoveStarted');
    expect(taken.events).toContainEqual({
      type: 'MoveEnded',
      entityId: 'ent_aria',
      reason: 'complete',
    });
    expect(taken.state.combat.resources['ent_goblin-minion_1']?.reaction).toBe(
      false,
    );
    expect(taken.state.entities.find((e) => e.id === 'ent_aria')!.pos).toEqual({
      x: 7,
      y: 6,
    });
    expectBalancedMovement([...moved.events, ...taken.events]);
  });

  it('decline: no attack is made and the move continues', () => {
    const { runtime, moved } = provoke();
    const declined = ok(
      runtime.execute(
        moved.state,
        'ent_goblin-minion_1',
        {
          command: 'reaction',
          reactionId: moved.state.pendingReaction!.reactionId,
          choice: 'decline',
        },
        { now: NOW + 1000 },
      ),
    );
    expect(
      declined.events.find((e) => e.type === 'ReactionResolved'),
    ).toMatchObject({
      used: false,
    });
    expect(types(declined.events)).not.toContain('RollEvent');
    expect(types(declined.events)).not.toContain('MoveStarted');
    expect(declined.events).toContainEqual({
      type: 'MoveEnded',
      entityId: 'ent_aria',
      reason: 'complete',
    });
    expect(
      [...moved.events, ...declined.events]
        .filter((event) =>
          ['MoveStarted', 'MoveEnded'].includes(String(event.type)),
        )
        .map((event) => event.type),
    ).toEqual(['MoveStarted', 'MoveEnded']);
    expectBalancedMovement([...moved.events, ...declined.events]);
    expect(declined.state.entities.find((e) => e.id === 'ent_aria')!.hp).toBe(
      30,
    );
    expect(
      declined.state.entities.find((e) => e.id === 'ent_aria')!.pos,
    ).toEqual({
      x: 7,
      y: 6,
    });
  });

  it('ends a queued reaction-paused move once when the first OA is lethal', () => {
    const { runtime, state } = engaged();
    const adjacent = placed(state, {
      ent_aria: { x: 7, y: 2 },
      'ent_goblin-minion_1': { x: 6, y: 2 },
      'ent_goblin-minion_2': { x: 6, y: 3 },
    });
    const fragile = {
      ...adjacent,
      entities: [
        ...adjacent.entities.map((entity) => ({
          ...entity,
          ...(entity.id === 'ent_aria' ? { hp: 1 } : {}),
          ...(entity.team === 'enemies' && entity.attacks?.length
            ? {
                attacks: entity.attacks.map((attack) => ({
                  ...attack,
                  attackBonus: 100,
                })),
              }
            : {}),
        })),
        {
          ...adjacent.entities.find((entity) => entity.id === 'ent_aria')!,
          id: 'ent_bob',
          name: 'Bob',
          pos: { x: 2, y: 2 },
          hp: 20,
        },
      ],
    };
    const moved = ok(
      runtime.execute(
        fragile,
        'ent_aria',
        { command: 'move', destination: { x: 10, y: 2 } },
        { now: NOW },
      ),
    );
    expect(
      moved.events.filter((event) => event.type === 'MoveStarted'),
    ).toHaveLength(1);
    expect(
      moved.events.filter((event) => event.type === 'MoveEnded'),
    ).toHaveLength(0);

    const firstPrompt = moved.state.pendingReaction!;
    const first = ok(
      runtime.execute(
        moved.state,
        firstPrompt.entityId,
        {
          command: 'reaction',
          reactionId: firstPrompt.reactionId,
          choice: 'take',
        },
        { now: NOW + 1 },
      ),
    );
    expect(
      first.state.entities.find((entity) => entity.id === 'ent_aria')?.hp,
    ).toBe(0);
    expect(first.state.pendingReaction).toBeDefined();
    expect(
      first.events.filter((event) => event.type === 'MoveEnded'),
    ).toHaveLength(0);

    const secondPrompt = first.state.pendingReaction!;
    const second = ok(
      runtime.execute(
        first.state,
        secondPrompt.entityId,
        {
          command: 'reaction',
          reactionId: secondPrompt.reactionId,
          choice: 'take',
        },
        { now: NOW + 2 },
      ),
    );
    const lifecycle = [
      ...moved.events,
      ...first.events,
      ...second.events,
    ].filter(
      (event) =>
        (event.type === 'MoveStarted' || event.type === 'MoveEnded') &&
        event.entityId === 'ent_aria',
    );
    expect(lifecycle).toEqual([
      expect.objectContaining({ type: 'MoveStarted', entityId: 'ent_aria' }),
      { type: 'MoveEnded', entityId: 'ent_aria', reason: 'incapacitated' },
    ]);
    expectBalancedMovement([
      ...moved.events,
      ...first.events,
      ...second.events,
    ]);
  });

  it('does not resume an interrupted path when a later step has become illegal', () => {
    const { runtime, moved } = provoke();
    const prompt = moved.state.pendingReaction!;
    const pending = moved.state.engineReactions![prompt.reactionId]!;
    const next = pending.remainingPath[0]!;
    const mover = moved.state.entities.find(
      (entity) => entity.id === 'ent_aria',
    )!;
    const blocked = {
      ...moved.state,
      map: {
        ...moved.state.map,
        edges: [
          ...moved.state.map.edges,
          { a: mover.pos, b: next, kind: 'wall' as const },
        ],
      },
    };
    const declined = ok(
      runtime.execute(
        blocked,
        prompt.entityId,
        {
          command: 'reaction',
          reactionId: prompt.reactionId,
          choice: 'decline',
        },
        { now: NOW + 1000 },
      ),
    );
    expect(
      declined.state.entities.find((entity) => entity.id === 'ent_aria')!.pos,
    ).toEqual(mover.pos);
    expect(declined.state.pendingReaction).toBeUndefined();
  });

  it('is idempotent: answering a resolved reaction is rejected without change', () => {
    const { runtime, moved } = provoke();
    const reactionId = moved.state.pendingReaction!.reactionId;
    const done = ok(
      runtime.execute(moved.state, 'ent_goblin-minion_1', {
        command: 'reaction',
        reactionId,
        choice: 'decline',
      }),
    );
    const again = runtime.execute(done.state, 'ent_goblin-minion_1', {
      command: 'reaction',
      reactionId,
      choice: 'take',
    });
    expect(again).toMatchObject({ code: 'not-your-turn' });
  });

  it('expire declines only once the 15 s deadline has passed', () => {
    const { runtime, moved } = provoke();
    expect(
      runtime.expire(moved.state, NOW + REACTION_TIMEOUT_MS - 1),
    ).toBeNull();
    const result = runtime.expire(moved.state, NOW + REACTION_TIMEOUT_MS)!;
    expect(
      result.events.find((e) => e.type === 'ReactionResolved'),
    ).toMatchObject({
      used: false,
    });
    expect(result.state.pendingReaction).toBeUndefined();
    expect(
      [...moved.events, ...result.events]
        .filter((event) =>
          ['MoveStarted', 'MoveEnded'].includes(String(event.type)),
        )
        .map((event) => event.type),
    ).toEqual(['MoveStarted', 'MoveEnded']);
    expectBalancedMovement([...moved.events, ...result.events]);
    expect(result.events).toContainEqual({
      type: 'MoveEnded',
      entityId: 'ent_aria',
      reason: 'complete',
    });
  });
});

describe('monster turns', () => {
  const finish = (seed: number) => {
    const { runtime, state } = engaged();
    const staged = {
      ...state,
      seed,
      entities: state.entities.map((e) =>
        e.id === 'ent_goblin-minion_2' ? { ...e, pos: { x: 6, y: 2 } } : e,
      ),
    };
    return ok(
      runtime.execute(
        staged,
        'ent_aria',
        { command: 'end-turn' },
        { now: NOW },
      ),
    );
  };

  it('are decided by the scripted policy, not an LLM, and deterministic by seed', () => {
    const a = finish(42);
    const b = finish(42);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const attacks = a.events.filter((e) => e.type === 'MonsterPolicy');
    expect(attacks.map((e) => e.decision)).toContain('attack');
    expect(types(a.events)).toContain('RollEvent');
    expect(a.state.combat.activeEntityId).toBe('ent_aria');
    expect(JSON.stringify(finish(43).events)).not.toBe(
      JSON.stringify(a.events),
    );
  });

  it('reveals a hidden monster when its scripted turn attacks', () => {
    const { runtime, state } = engaged();
    const staged = {
      ...state,
      seed: 42,
      entities: state.entities.map((entity) =>
        entity.id === 'ent_goblin-minion_1'
          ? { ...entity, pos: { x: 8, y: 2 }, hidden: true }
          : entity,
      ),
    };
    const result = ok(
      runtime.execute(
        staged,
        'ent_aria',
        { command: 'end-turn' },
        { now: NOW },
      ),
    );
    expect(result.events).toContainEqual({
      type: 'EntityRevealed',
      entityId: 'ent_goblin-minion_1',
      cause: 'attack',
    });
    expect(
      result.state.entities.find(
        (entity) => entity.id === 'ent_goblin-minion_1',
      )?.hidden,
    ).toBe(false);
  });

  it('resolves a live goblin turn with its catalog dagger damage type', () => {
    const { runtime, state } = engaged();
    const staged = {
      ...state,
      seed: 42,
      entities: state.entities.map((entity) =>
        entity.id === 'ent_aria'
          ? { ...entity, ac: 1 }
          : entity.id === 'ent_goblin-minion_1'
            ? { ...entity, pos: { x: 8, y: 2 } }
            : entity,
      ),
    };
    const result = ok(
      runtime.execute(
        staged,
        'ent_aria',
        { command: 'end-turn' },
        { now: NOW },
      ),
    );
    const roll = result.events.find((event) => event.type === 'RollEvent');
    const damage = result.events.find((event) => event.type === 'HpChanged');

    expect(roll?.attackId).toBe('dagger');
    expect(damage?.damageType).toBe('piercing');
  });

  it('hidden bump approach is invariant to a second hidden occupant', () => {
    const { runtime, state } = bootstrapped();
    const hiddenId = 'ent_goblin-minion_1';
    const secondId = 'ent_goblin-minion_2';
    const run = (withSecond: boolean) => {
      const staged = placed(state, {
        ent_aria: { x: 0, y: 1 },
        [hiddenId]: { x: 3, y: 1 },
        [secondId]: { x: 2, y: 0 },
      });
      staged.entities = staged.entities
        .filter((entity) => withSecond || entity.id !== secondId)
        .map((entity) =>
          entity.id === hiddenId || entity.id === secondId
            ? { ...entity, hidden: true }
            : entity,
        );
      staged.combat.resources.ent_aria!.movementRemaining = 30;
      return ok(
        runtime.execute(
          staged,
          'ent_aria',
          { command: 'move', destination: { x: 3, y: 1 } },
          { now: NOW },
        ),
      );
    };
    const alone = run(false);
    const together = run(true);
    const heroPos = (result: typeof alone) =>
      result.state.entities.find((entity) => entity.id === 'ent_aria')?.pos;
    expect(heroPos(alone)).toEqual(heroPos(together));
    expect(alone.events).toEqual(together.events);
    expect(heroPos(alone)).not.toEqual({ x: 3, y: 1 });
    expect(alone.events).toContainEqual({
      type: 'EntityRevealed',
      entityId: hiddenId,
      cause: 'bump',
    });
    expect(alone.events).not.toContainEqual(
      expect.objectContaining({ entityId: secondId }),
    );
  });

  it('approach from across the map, then end combat when the rules say so', () => {
    const { runtime, state } = bootstrapped();
    let current = state;
    const log: string[] = [];
    for (let guard = 0; guard < 40 && !current.ended; guard++) {
      const here = current.entities.find((e) => e.id === 'ent_aria')!;
      const foe = current.entities
        .filter((e) => e.team === 'enemies' && e.hp > 0)
        .sort(
          (a, b) =>
            Math.hypot(a.pos.x - here.pos.x, a.pos.y - here.pos.y) -
            Math.hypot(b.pos.x - here.pos.x, b.pos.y - here.pos.y),
        )[0]!;
      const near = Math.max(
        Math.abs(foe.pos.x - here.pos.x),
        Math.abs(foe.pos.y - here.pos.y),
      );
      const result =
        near <= 1 && current.combat.resources.ent_aria?.action
          ? runtime.execute(
              current,
              'ent_aria',
              { command: 'attack', targetId: foe.id, attackId: 'staff' },
              { character: hero, now: NOW },
            )
          : runtime.execute(
              current,
              'ent_aria',
              { command: 'end-turn' },
              { now: NOW },
            );
      const step = ok(result);
      log.push(...types(step.events));
      current = step.state;
      if (current.pendingReaction)
        current = ok(
          runtime.execute(current, 'ent_aria', {
            command: 'reaction',
            reactionId: current.pendingReaction.reactionId,
            choice: 'decline',
          }),
        ).state;
      // The runtime test has no Room/narrator; model the persisted narration
      // commit boundary before the next initiative turn.
      if (current.phase === 'narrating')
        current = { ...current, phase: 'awaiting-command' };
    }
    expect(current.ended?.outcome).toMatch(/party-victory|party-defeated/);
    expect(log.filter((t) => t === 'CombatEnded')).toHaveLength(1);
    expect(log).toContain('MonsterPolicy');
    expect(catalog.get('monster', 'monster:goblin-minion')).toBeDefined();
  });
});

describe('Room: reaction deadline survives restarts', () => {
  const stage = async () => {
    const e = engaged();
    const moved = ok(
      e.runtime.execute(
        e.state,
        'ent_aria',
        {
          command: 'move',
          destination: { x: 7, y: 6 },
        },
        { now: Date.now() },
      ),
    );
    const table = memoryTable({
      characters: { [account]: hero },
      combatActors: { [account]: 'ent_aria' },
      combatRoom: moved.state,
    });
    return { table, moved };
  };

  it('auto-declines at 15 s on a fake clock and broadcasts the result', async () => {
    vi.useFakeTimers();
    const { table, moved } = await stage();
    const room = table.boot();
    await joinSeated(room, account, table.connection);
    expect(moved.state.pendingReaction).toBeDefined();
    await vi.advanceTimersByTimeAsync(REACTION_TIMEOUT_MS - 1000);
    expect(table.events.some((e) => e.type === 'ReactionResolved')).toBe(false);
    await vi.advanceTimersByTimeAsync(1001);
    await room.drain();
    const resolved = table.events.find((e) => e.type === 'ReactionResolved');
    expect(resolved?.payload).toMatchObject({ used: false });
    const saved = table.game().combatRoom as RoomCombatState;
    expect(saved.pendingReaction).toBeUndefined();
    expect(
      table.messages.filter((m) => m.type === 'CombatTracker').length,
    ).toBeGreaterThan(0);
  });

  it('does not let a seat answer an uncontrolled NPC reaction and declines it at the fake-clock deadline', async () => {
    vi.useFakeTimers();
    const { table, moved } = await stage();
    const room = table.boot();
    await joinSeated(room, account, table.connection);
    const prompt = moved.state.pendingReaction!;
    expect(prompt.entityId).toBe('ent_goblin-minion_1');
    await room.submitCombatCommand(account, crypto.randomUUID(), {
      command: 'reaction',
      reactionId: prompt.reactionId,
      choice: 'take',
    });
    expect(
      table.events.some((event) => event.type === 'ReactionResolved'),
    ).toBe(false);
    await vi.advanceTimersByTimeAsync(REACTION_TIMEOUT_MS + 1);
    await room.drain();
    expect(
      table.events.filter((event) => event.type === 'ReactionResolved'),
    ).toHaveLength(1);
    expect(
      table.events.find((event) => event.type === 'ReactionResolved')?.payload,
    ).toMatchObject({ used: false, entityId: 'ent_goblin-minion_1' });
  });

  it('a restart mid-prompt resumes with the remaining time, then declines', async () => {
    vi.useFakeTimers();
    const { table } = await stage();
    const first = table.boot();
    const initial = table.game().combatRoom as RoomCombatState;
    expect(initial.phase).toBe('reaction-pending');
    expect(Object.keys(initial.engineReactions ?? {})).not.toHaveLength(0);
    await vi.advanceTimersByTimeAsync(10_000);
    await first.drain(); // process dies with the prompt still open
    expect(table.events.some((e) => e.type === 'ReactionResolved')).toBe(false);
    const second = table.boot();
    await second.join(account, table.connection);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(table.events.some((e) => e.type === 'ReactionResolved')).toBe(false);
    await vi.advanceTimersByTimeAsync(1_100);
    await second.drain();
    expect(
      table.events.filter((e) => e.type === 'ReactionResolved'),
    ).toHaveLength(1);
  });

  it('a restart after the deadline declines immediately', async () => {
    vi.useFakeTimers();
    const { table } = await stage();
    const first = table.boot();
    await first.drain();
    await vi.advanceTimersByTimeAsync(60_000);
    const second = table.boot();
    await second.join(account, table.connection);
    await vi.advanceTimersByTimeAsync(10);
    await second.drain();
    expect(
      table.events.filter((e) => e.type === 'ReactionResolved'),
    ).toHaveLength(1);
  });

  it('a late human answer after the auto-decline changes nothing', async () => {
    vi.useFakeTimers();
    const { table, moved } = await stage();
    const room = table.boot();
    await joinSeated(room, account, table.connection);
    await vi.advanceTimersByTimeAsync(REACTION_TIMEOUT_MS + 10);
    const count = table.events.length;
    await room.submitCombatCommand(account, crypto.randomUUID(), {
      command: 'reaction',
      reactionId: moved.state.pendingReaction!.reactionId,
      choice: 'take',
    });
    expect(table.events).toHaveLength(count);
    await room.drain();
  });

  it('another account cannot command your table', async () => {
    const { table } = await stage();
    const room = table.boot();
    await expect(
      room.submitCombatCommand(crypto.randomUUID(), crypto.randomUUID(), {
        command: 'end-turn',
      }),
    ).rejects.toThrow('not seated');
    const intruder = crypto.randomUUID();
    await room.join(intruder, { send() {} });
    const count = table.events.length;
    await room.submitCombatCommand(intruder, crypto.randomUUID(), {
      command: 'end-turn',
    });
    expect(table.events).toHaveLength(count);
    await room.drain();
  });
});

describe('Room: one persisted narration per resolved combat turn', () => {
  it('closes a terminal combat turn after its single narration commits', async () => {
    const e = bootstrapped();
    const combat: RoomCombatState = {
      ...e.state,
      phase: 'awaiting-command',
      turnId: 'combat-turn-final',
      narrationAttempts: 0,
      entities: e.state.entities.map((entity) =>
        entity.team === 'enemies' ? { ...entity, hp: 0 } : entity,
      ),
      combat: { ...e.state.combat, activeEntityId: 'ent_aria' },
    };
    let narrationStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      narrationStarted = resolve;
    });
    const requests: {
      combatNarration?: boolean;
      text?: string;
      playerName?: string;
    }[] = [];
    const runner = {
      async run(request: unknown) {
        requests.push(request as (typeof requests)[number]);
        narrationStarted();
        return {
          narration: 'The encounter ends.',
          events: [],
          state: (request as { state?: unknown }).state ?? {},
          usage: { in: 1, out: 1 },
        } as never;
      },
    };
    const table = memoryTable(
      {
        ...e.game,
        lastCombatBeat: 'A stale previous combat beat.',
        combatActors: { [account]: 'ent_aria' },
        combatRoom: combat,
      },
      runner,
    );
    const room = table.boot();
    await joinSeated(room, account, table.connection);
    await room.submitCombatCommand(account, crypto.randomUUID(), {
      command: 'end-turn',
    });
    await room.setPaused(account, false, true);
    await started;
    await room.drain();

    const ended = table.game().combatRoom as RoomCombatState;
    expect(table.events.some((event) => event.type === 'CombatEnded')).toBe(
      true,
    );
    expect(
      table.events.filter((event) => event.type === 'TurnResolved'),
    ).toHaveLength(1);
    expect(
      table.events.filter((event) => event.type === 'NarrationCommitted'),
    ).toHaveLength(1);
    expect(requests.map((r) => r.combatNarration)).toEqual([true]);
    expect(requests[0]!.text).toMatch(
      /^\[Combat resolved by the engine; narrate it, do not change it\]$/,
    );
    expect(requests[0]!.playerName).toBe('Combat');
    expect(table.events.some((event) => event.type === 'TurnOpened')).toBe(
      false,
    );
    expect(ended.phase).toBeUndefined();
    expect(ended.turnId).toBeUndefined();
    expect(ended.turnDeadline).toBeUndefined();
    expect(table.game()).not.toHaveProperty('lastCombatBeat');
  });

  it('admits by turn ownership before revealing an in-flight narration gate', async () => {
    const e = bootstrapped();
    const otherAccount = crypto.randomUUID();
    let releaseNarration!: () => void;
    let narrationStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      narrationStarted = resolve;
    });
    const waitForNarration = new Promise<void>((resolve) => {
      releaseNarration = resolve;
    });
    const runner = {
      async run(request: unknown) {
        narrationStarted();
        await waitForNarration;
        return {
          narration: 'The turn resolves.',
          events: [],
          state: (request as { state?: unknown }).state ?? {},
          usage: { in: 1, out: 1 },
        } as never;
      },
    };
    const combat: RoomCombatState = {
      ...e.state,
      phase: 'awaiting-command',
      turnId: 'combat-turn-admission',
      narrationAttempts: 0,
      combat: { ...e.state.combat, activeEntityId: 'ent_aria' },
    };
    const table = memoryTable(
      {
        ...e.game,
        combatActors: {
          [account]: 'ent_aria',
          [otherAccount]: 'ent_goblin-minion_1',
        },
        combatRoom: combat,
      },
      runner,
    );
    const room = table.boot();
    await joinSeated(room, account, table.connection);
    const otherMessages: import('@game/schema').ServerMessage[] = [];
    await joinSeated(room, otherAccount, {
      send: (message) => otherMessages.push(message),
    });

    await room.submitCombatCommand(account, crypto.randomUUID(), {
      command: 'end-turn',
    });
    await room.setPaused(account, false, true);
    await started;
    await room.submitCombatCommand(otherAccount, crypto.randomUUID(), {
      command: 'end-turn',
    });

    expect(otherMessages.at(-1)).toMatchObject({
      type: 'Error',
      payload: { code: 'not-your-turn' },
    });
    expect(JSON.stringify(otherMessages.at(-1))).not.toMatch(/narrat/i);
    releaseNarration();
    await room.drain();
  });

  it('keeps TurnResolved and its eventIds off the other seated player socket', async () => {
    const e = bootstrapped();
    const otherAccount = crypto.randomUUID();
    const combat: RoomCombatState = {
      ...e.state,
      phase: 'awaiting-command',
      turnId: 'combat-turn-private-resolution',
      narrationAttempts: 0,
      entities: e.state.entities.map((entity) =>
        entity.id === 'ent_goblin-minion_1'
          ? { ...entity, hidden: true }
          : entity,
      ),
      combat: { ...e.state.combat, activeEntityId: 'ent_aria' },
    };
    const runner = {
      async run(
        request: unknown,
        onEvent: (event: { type: string; tier: string }) => void,
      ) {
        onEvent({ type: 'NarrationTier', tier: 'standard' });
        return {
          narration: 'The turn resolves.',
          events: [],
          state: (request as { state?: unknown }).state ?? {},
          usage: { in: 1, out: 1 },
        } as never;
      },
    };
    const table = memoryTable(
      {
        ...e.game,
        combatActors: {
          [account]: 'ent_aria',
          [otherAccount]: 'ent_goblin-minion_1',
        },
        combatRoom: combat,
      },
      runner,
    );
    const room = table.boot();
    await joinSeated(room, account, table.connection);
    const otherMessages: import('@game/schema').ServerMessage[] = [];
    await joinSeated(room, otherAccount, {
      send: (message) => otherMessages.push(message),
    });

    await room.submitCombatCommand(account, crypto.randomUUID(), {
      command: 'end-turn',
    });
    await room.setPaused(account, false, true);
    await room.drain();

    expect(table.events.some((event) => event.type === 'TurnResolved')).toBe(
      true,
    );
    expect((table.game() as Record<string, unknown>).lastCombatBeat).toBe(
      'The turn resolves.',
    );
    expect(
      otherMessages.some((message) => message.type === 'TurnResolved'),
    ).toBe(false);
    expect(JSON.stringify(otherMessages)).not.toMatch(/eventIds/);
  });

  it('keeps the room consistent with the store when stored seqs have a gap', async () => {
    const e = bootstrapped();
    const combat: RoomCombatState = {
      ...e.state,
      phase: 'awaiting-command',
      turnId: 'combat-turn-gap',
      narrationAttempts: 0,
      combat: { ...e.state.combat, activeEntityId: 'ent_aria' },
    };
    const table = memoryTable({
      ...e.game,
      combatActors: { [account]: 'ent_aria' },
      combatRoom: combat,
    });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const room = table.boot();
    await joinSeated(room, account, table.connection);
    table.faults.gapAfterIndex = 0;
    // The durable write succeeded, so the command must not throw.
    await room.submitCombatCommand(account, crypto.randomUUID(), {
      command: 'end-turn',
    });
    table.faults.gapAfterIndex = -1;
    // A second end-turn must be refused from the updated (narrating) state.
    await room
      .submitCombatCommand(account, crypto.randomUUID(), {
        command: 'end-turn',
      })
      .catch(() => undefined);
    expect(
      table.events.filter((event) => event.type === 'TurnResolved'),
    ).toHaveLength(1);
    expect(errors).toHaveBeenCalledWith(
      expect.stringMatching(/non-contiguous/),
    );
    errors.mockRestore();
  });

  it('persists TurnResolved and holds the next turn in narrating phase', async () => {
    const e = bootstrapped();
    const combat: RoomCombatState = {
      ...e.state,
      phase: 'awaiting-command',
      turnId: 'combat-turn-1',
      narrationAttempts: 0,
      combat: { ...e.state.combat, activeEntityId: 'ent_aria' },
    };
    let narrationStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      narrationStarted = resolve;
    });
    let calls = 0;
    const runner = {
      async run(request: unknown) {
        calls++;
        narrationStarted();
        return {
          narration: 'The turn resolves.',
          events: [],
          state: (request as { state?: unknown }).state ?? {},
          usage: { in: 1, out: 1 },
        } as never;
      },
    };
    const table = memoryTable(
      {
        ...e.game,
        combatActors: { [account]: 'ent_aria' },
        combatRoom: combat,
      },
      runner,
    );
    const room = table.boot();
    await joinSeated(room, account, table.connection);
    await room.submitCombatCommand(account, crypto.randomUUID(), {
      command: 'dodge',
    });
    expect(calls).toBe(0);
    await room.submitCombatCommand(account, crypto.randomUUID(), {
      command: 'end-turn',
    });
    await room.setPaused(account, false, true);
    await started;
    await room.drain();

    expect(calls).toBe(1);
    const resolved = table.events.find(
      (event) => event.type === 'TurnResolved',
    );
    const dodge = table.events.find((event) => event.type === 'DodgeDeclared');
    expect(
      table.events.filter((event) => event.type === 'TurnResolved'),
    ).toHaveLength(1);
    expect(resolved?.payload).toMatchObject({
      eventIds: expect.arrayContaining([
        expect.any(String),
        expect.any(String),
      ]),
    });
    const eventIds = (resolved?.payload as { eventIds: string[] }).eventIds;
    expect(eventIds).toContain(String(dodge?.seq));
    expect(eventIds.map(Number)).toEqual(
      [...eventIds].map(Number).sort((left, right) => left - right),
    );
    expect(
      eventIds.every((id) =>
        table.events.some((event) => String(event.seq) === id),
      ),
    ).toBe(true);
    const narratedFacts = table.game().combatRoom as RoomCombatState;
    expect(narratedFacts.turnNarrationEvents).toBeUndefined();
    expect(
      table.events.filter((event) => event.type === 'NarrationAttemptStarted'),
    ).toHaveLength(1);
    expect(
      table.events.filter((event) => event.type === 'NarrationCommitted'),
    ).toHaveLength(1);
    expect(
      table.events.filter((event) => event.type === 'TurnOpened'),
    ).toHaveLength(1);
    expect(
      table.messages.some(
        (message) =>
          message.type === 'CombatEvents' &&
          (message.payload as { events?: { type?: string }[] }).events?.some(
            (event) => event.type === 'TurnOpened',
          ),
      ),
    ).toBe(true);
    expect((table.game().combatRoom as RoomCombatState).phase).toBe(
      'awaiting-command',
    );
    const syncedCombat = table.messages
      .filter((message) => message.type === 'StateSync')
      .map(
        (message) =>
          (
            message.payload as {
              state?: { gameState?: { combatRoom?: Record<string, unknown> } };
            }
          ).state?.gameState?.combatRoom,
      )
      .filter((state): state is Record<string, unknown> => !!state);
    expect(
      syncedCombat.every((state) => !('turnNarrationEvents' in state)),
    ).toBe(true);
  });

  it('narrates a no-op turn exactly once and does not re-narrate after recovery', async () => {
    const e = bootstrapped();
    const requests: { text?: string }[] = [];
    let narrationStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      narrationStarted = resolve;
    });
    const runner = {
      async run(request: unknown) {
        requests.push(request as { text?: string });
        narrationStarted();
        return {
          narration: 'Nothing happens.',
          events: [],
          state: (request as { state?: unknown }).state ?? {},
          usage: { in: 1, out: 1 },
        } as never;
      },
    };
    const game = {
      ...e.game,
      combatActors: { [account]: 'ent_aria' },
      combatRoom: {
        ...e.state,
        phase: 'awaiting-command',
        turnId: 'noop-turn',
        narrationAttempts: 0,
        combat: { ...e.state.combat, activeEntityId: 'ent_aria' },
      } as RoomCombatState,
    };
    const table = memoryTable(game, runner);
    const room = table.boot();
    await joinSeated(room, account, table.connection);
    await room.submitCombatCommand(account, crypto.randomUUID(), {
      command: 'end-turn',
    });
    await room.setPaused(account, false, true);
    await started;
    await room.drain();
    expect(requests).toHaveLength(1);
    expect(
      table.events.filter((event) => event.type === 'NarrationCommitted'),
    ).toHaveLength(1);

    // A restart after the commit sees an open next turn, not an unnarrated one.
    const committed = table.game().combatRoom as RoomCombatState;
    expect(committed.phase).toBe('awaiting-command');
    const again = memoryTable(
      { ...table.game(), combatRoom: committed },
      runner,
    );
    const rebooted = again.boot();
    await joinSeated(rebooted, account, again.connection);
    await rebooted.setPaused(account, false, true);
    await rebooted.drain();
    expect(requests).toHaveLength(1);
  });

  it('stores standard combat beats and clears a prior beat after mature narration', async () => {
    const runCombatTurn = async (tier: 'standard' | 'mature' | 'unknown') => {
      const e = bootstrapped();
      let narrationStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        narrationStarted = resolve;
      });
      const runner = {
        async run(
          _request: unknown,
          onEvent: (event: { type: string; tier?: string }) => void,
        ) {
          onEvent({ type: 'NarrationTier', tier });
          narrationStarted();
          return {
            narration: `${tier} combat beat`,
            events: [],
            state: (_request as { state?: unknown }).state ?? {},
            usage: { in: 1, out: 1 },
          } as never;
        },
      };
      const priorBeat = 'the previous public beat';
      const game = {
        ...e.game,
        lastCombatBeat: priorBeat,
        combatActors: { [account]: 'ent_aria' },
        combatRoom: {
          ...e.state,
          phase: 'awaiting-command',
          turnId: `${tier}-turn`,
          narrationAttempts: 0,
          combat: { ...e.state.combat, activeEntityId: 'ent_aria' },
        } as RoomCombatState,
      };
      const table = memoryTable(game, runner);
      const room = table.boot();
      await joinSeated(room, account, table.connection);
      await room.submitCombatCommand(account, crypto.randomUUID(), {
        command: 'end-turn',
      });
      await room.setPaused(account, false, true);
      await started;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { room, table, priorBeat };
    };

    const standard = await runCombatTurn('standard');
    expect(standard.table.game().lastCombatBeat).toBe('standard combat beat');
    const mature = await runCombatTurn('mature');
    expect(mature.table.game()).not.toHaveProperty('lastCombatBeat');
    const unknown = await runCombatTurn('unknown');
    expect(unknown.table.game()).not.toHaveProperty('lastCombatBeat');
  });

  it('excludes hidden-entity facts from recovered combat narration input', async () => {
    const e = bootstrapped();
    let promptText = '';
    const runner = {
      async run(request: unknown) {
        promptText = JSON.stringify(
          (request as { combatFacts?: unknown }).combatFacts ?? [],
        );
        return {
          narration: 'The turn resolves.',
          events: [],
          state: (request as { state?: unknown }).state ?? {},
          usage: { in: 1, out: 1 },
        } as never;
      },
    };
    const combat: RoomCombatState = {
      ...e.state,
      phase: 'narrating',
      turnId: 'hidden-fact-turn',
      narrationAttempts: 0,
      entities: e.state.entities.map((entity) =>
        entity.id === 'ent_goblin-minion_1'
          ? { ...entity, hidden: true }
          : entity,
      ),
      turnNarrationEvents: [
        {
          type: 'HpChanged',
          entityId: 'ent_goblin-minion_1',
          delta: -9,
          hp: 1,
        },
        { type: 'HpChanged', entityId: 'ent_aria', delta: -1, hp: 9 },
        {
          type: 'RollEvent',
          entityId: 'ent_aria',
          targetId: 'ent_goblin-minion_1',
          attackId: 'weapon:bow',
          kind: 'attack',
          targetAc: 12,
          hit: true,
          breakdown: { total: 16 },
        },
      ],
      combat: { ...e.state.combat, activeEntityId: 'ent_aria' },
    };
    const table = memoryTable(
      {
        ...e.game,
        combatActors: { [account]: 'ent_aria' },
        combatRoom: combat,
      },
      runner,
    );
    const room = table.boot();
    await room.setPaused(account, false, true);
    await room.drain();
    expect(promptText).not.toContain('ent_goblin-minion_1');
    expect(promptText).not.toContain('delta:-9');
    expect(promptText).toContain('ent_aria');
  });

  it('retries an interrupted narration once after recovery with the persisted attempt count', async () => {
    const e = bootstrapped();
    let narrationStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      narrationStarted = resolve;
    });
    const runner = {
      async run(request: unknown) {
        narrationStarted();
        return {
          narration: 'The recovered turn resolves.',
          events: [],
          state: (request as { state?: unknown }).state ?? {},
          usage: { in: 1, out: 1 },
        } as never;
      },
    };
    const combat: RoomCombatState = {
      ...e.state,
      phase: 'narrating',
      turnId: 'saved-turn',
      narrationAttempts: 1,
      turnNarrationEvents: [
        { type: 'HpChanged', entityId: 'ent_aria', delta: -1, hp: 9 },
      ],
      combat: { ...e.state.combat, activeEntityId: 'ent_aria' },
    };
    const table = memoryTable(
      {
        ...e.game,
        combatActors: { [account]: 'ent_aria' },
        combatRoom: combat,
      },
      runner,
    );
    const room = table.boot();
    await joinSeated(room, account, table.connection);
    await room.setPaused(account, false, true);
    await started;
    await room.drain();

    expect(
      table.events.find((event) => event.type === 'NarrationAttemptStarted')
        ?.payload,
    ).toMatchObject({
      turnId: 'saved-turn',
      attempt: 2,
    });
    expect(
      table.events.filter((event) => event.type === 'NarrationCommitted'),
    ).toHaveLength(1);
    expect(
      table.events.filter((event) => event.type === 'TurnOpened'),
    ).toHaveLength(1);
  });

  it('persists endpoint-error fallback and advances a combat turn', async () => {
    const e = bootstrapped();
    const combat: RoomCombatState = {
      ...e.state,
      phase: 'narrating',
      turnId: 'endpoint-failure-turn',
      narrationAttempts: 0,
      turnNarrationEvents: [
        { type: 'HpChanged', entityId: 'ent_aria', delta: -1, hp: 9 },
      ],
      combat: { ...e.state.combat, activeEntityId: 'ent_aria' },
    };
    let narrationStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      narrationStarted = resolve;
    });
    const runner = {
      async run() {
        narrationStarted();
        throw new Error('narration endpoint unavailable');
      },
    };
    const table = memoryTable(
      {
        ...e.game,
        combatActors: { [account]: 'ent_aria' },
        combatRoom: combat,
      },
      runner,
    );
    const room = table.boot();
    await joinSeated(room, account, table.connection);
    await room.setPaused(account, false, true);
    await started;
    await room.drain();

    expect(
      table.events.find((event) => event.type === 'TurnFallback')?.payload,
    ).toMatchObject({
      turnId: 'endpoint-failure-turn',
      reason: 'endpoint-error',
    });
    expect(
      table.events.filter((event) => event.type === 'NarrationCommitted'),
    ).toHaveLength(1);
    expect(
      table.events.filter((event) => event.type === 'TurnOpened'),
    ).toHaveLength(1);
  });

  it('commits the ADR-022 fallback without another DM call after two interrupted attempts', async () => {
    const e = bootstrapped();
    const combat: RoomCombatState = {
      ...e.state,
      phase: 'narrating',
      turnId: 'saved-turn',
      narrationAttempts: 2,
      turnNarrationEvents: [
        { type: 'HpChanged', entityId: 'ent_aria', delta: -1, hp: 9 },
      ],
      combat: { ...e.state.combat, activeEntityId: 'ent_aria' },
    };
    let calls = 0;
    const runner = {
      async run() {
        calls++;
        throw new Error('fallback must not invoke the DM');
      },
    };
    const table = memoryTable(
      {
        ...e.game,
        combatActors: { [account]: 'ent_aria' },
        combatRoom: combat,
      },
      runner,
    );
    const room = table.boot();
    await joinSeated(room, account, table.connection);
    await room.setPaused(account, false, true);
    await room.drain();

    expect(calls).toBe(0);
    expect(
      table.events.find((event) => event.type === 'NarrationCompleted')
        ?.payload,
    ).toMatchObject({
      narration: expect.stringContaining('storyteller has lost the thread'),
      words: expect.any(Number),
      tier: 'standard',
    });
    expect(
      table.events.filter((event) => event.type === 'NarrationCommitted'),
    ).toHaveLength(1);
    expect(
      table.events.filter((event) => event.type === 'TurnOpened'),
    ).toHaveLength(1);
  });
});

describe('reaction hardening (M4-6d carry-overs)', () => {
  const leave = { command: 'move', destination: { x: 7, y: 6 } } as const;
  const provoked = () => {
    const e = engaged();
    const moved = ok(
      e.runtime.execute(e.state, 'ent_aria', leave, { now: NOW }),
    );
    return { ...e, moved };
  };
  it('engine answerReaction accepts the reactor only, never the mover', () => {
    const { moved } = provoked();
    const prompt = moved.state.pendingReaction!;
    expect(
      answerReaction(
        moved.state,
        prompt.moverId,
        prompt.reactionId,
        'decline',
        NOW,
      ),
    ).toMatchObject({ code: 'COMMAND_REJECTED' });
    expect(
      answerReaction(
        moved.state,
        prompt.entityId,
        prompt.reactionId,
        'decline',
        NOW,
      ),
    ).not.toHaveProperty('code');
  });

  it('Room closes an expiry the engine will not resolve once, and never re-arms the timer at zero', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const e = engaged();
    const moved = ok(
      e.runtime.execute(e.state, 'ent_aria', leave, { now: Date.now() }),
    );
    const table = memoryTable({
      characters: { [account]: hero },
      combatActors: { [account]: 'ent_aria' },
      combatRoom: moved.state,
    });
    const stuck = { ...e.runtime, expire: () => null };
    const room = table.boot([], stuck);
    await joinSeated(room, account, table.connection);
    await vi.advanceTimersByTimeAsync(REACTION_TIMEOUT_MS + 1);
    await room.drain();
    expect(
      (table.game().combatRoom as RoomCombatState).pendingReaction,
    ).toBeUndefined();
    const closed = table.events.filter(
      (event) => event.type === 'ReactionResolved',
    );
    expect(closed).toHaveLength(1);
    expect(closed[0]?.payload).toMatchObject({ used: false });
    expect(
      table.events.filter((event) => event.type === 'MoveEnded'),
    ).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(
      table.events.filter((event) => event.type === 'ReactionResolved'),
    ).toHaveLength(1);
  });
});

describe('hidden bump route invariance (route planning ignores hidden occupants)', () => {
  const HERO = 'ent_aria';
  const G1 = 'ent_goblin-minion_1';
  const G2 = 'ent_goblin-minion_2';
  // The crypt room walls (0,0) and (2,0), so these cells need an open map.
  const open = mapFrom(Array.from({ length: 10 }, () => '.'.repeat(10)));
  /** Hero walks from (0,0) to hidden G1 at (3,1); `second` is a hidden G2 cell, or G2 is absent. */
  const walk = (
    second: { x: number; y: number } | null,
    controlled = false,
  ) => {
    const { runtime, state } = bootstrapped();
    const positioned = placed(state, {
      [HERO]: { x: 0, y: 0 },
      [G1]: { x: 3, y: 1 },
      [G2]: second ?? { x: 7, y: 7 },
    });
    const staged = {
      ...positioned,
      map: open,
      entities: positioned.entities
        .filter((entity) => second !== null || entity.id !== G2)
        .map((entity) =>
          entity.id === G1 || entity.id === G2
            ? { ...entity, hidden: true }
            : entity,
        ),
    };
    staged.combat.resources[HERO]!.movementRemaining = 30;
    return ok(
      runtime.execute(
        staged,
        HERO,
        { command: 'move', destination: { x: 3, y: 1 } },
        controlled
          ? { now: NOW, controlledEntityIds: new Set([G2]) }
          : { now: NOW },
      ),
    );
  };
  const routeOf = (result: ReturnType<typeof walk>) =>
    result.events.find((event) => event.type === 'MoveStarted')?.path;

  it('route planning ignores a hidden second even when the mover controls it', () => {
    const alone = walk(null);
    const controlled = walk({ x: 2, y: 0 }, true);
    expect(routeOf(controlled)).toEqual(routeOf(alone));
  });
});

describe('reaction visibility split (ADR-033 §3.2, ADR-034 §3)', () => {
  type Msg = import('@game/schema').ServerMessage;
  const inbox = () => {
    const messages: Msg[] = [];
    return {
      messages,
      connection: { send: (m: Msg) => void messages.push(m) },
    };
  };
  const eventTypes = (messages: Msg[]) =>
    messages
      .filter((m) => m.type === 'CombatEvents')
      .flatMap((m) =>
        (m.payload as { events: { type: string }[] }).events.map((e) => e.type),
      );
  const mentions = (messages: Msg[], id: string) =>
    messages.some((m) => JSON.stringify(m.payload).includes(id));

  /** ent_aria (account) is the reactor against a goblin mover; a second seat watches. */
  const stageReactor = (hidden: boolean) => {
    const e = engaged();
    const other = crypto.randomUUID();
    const combat: RoomCombatState = {
      ...e.state,
      phase: 'reaction-pending',
      entities: e.state.entities.map((entity) =>
        entity.id === 'ent_aria' && hidden ? { ...entity, hidden } : entity,
      ),
      pendingReaction: {
        reactionId: 'r1',
        entityId: 'ent_aria',
        trigger: 'opportunityAttack',
        moverId: 'ent_goblin-minion_1',
        deadlineAt: Date.now() + REACTION_TIMEOUT_MS,
      },
    };
    const table = memoryTable({
      ...e.game,
      combatActors: { [account]: 'ent_aria' },
      combatRoom: combat,
    });
    return { table, other };
  };

  it('connect/snapshot: controller gets options, others get only open + deadline', async () => {
    vi.useFakeTimers();
    const { table, other } = stageReactor(false);
    const room = table.boot();
    await joinSeated(room, account, table.connection);
    const watcher = inbox();
    await joinSeated(room, other, watcher.connection);
    const mine = table.messages.find((m) => m.type === 'ReactionPrompt');
    expect(mine?.payload).toMatchObject({
      reactionId: 'r1',
      trigger: 'opportunityAttack',
      options: ['take', 'decline'],
    });
    expect(watcher.messages.some((m) => m.type === 'ReactionPrompt')).toBe(
      false,
    );
    const open = watcher.messages.find((m) => m.type === 'ReactionPromptOpen');
    expect(Object.keys(open!.payload).sort()).toEqual([
      'deadlineAt',
      'reactionId',
      'reactorEntityId',
      'timeoutMs',
    ]);
    expect(JSON.stringify(watcher.messages)).not.toContain('opportunityAttack');
    expect(mentions(watcher.messages, 'pendingReaction')).toBe(false);
    expect(mentions(table.messages, 'pendingReaction')).toBe(true);
    expect(JSON.stringify(open)).not.toContain('ent_goblin-minion_1');
    await room.drain();
  });

  it('connect/snapshot: a hidden reactor is invisible to other seats, not to its controller', async () => {
    vi.useFakeTimers();
    const { table, other } = stageReactor(true);
    const room = table.boot();
    await joinSeated(room, account, table.connection);
    const watcher = inbox();
    await joinSeated(room, other, watcher.connection);
    expect(table.messages.some((m) => m.type === 'ReactionPrompt')).toBe(true);
    expect(
      watcher.messages.filter((m) => m.type.startsWith('ReactionPrompt')),
    ).toEqual([]);
    // Neither the tracker nor the state snapshot names the hidden reactor.
    const ids = (messages: Msg[]) =>
      messages
        .filter((m) => m.type === 'CombatTracker')
        .flatMap((m) =>
          (m.payload as { entities: { id: string }[] }).entities.map(
            (e) => e.id,
          ),
        );
    expect(ids(watcher.messages)).not.toContain('ent_aria');
    expect(ids(table.messages)).toContain('ent_aria');
    const synced = (messages: Msg[]) =>
      messages
        .filter((m) => m.type === 'StateSync')
        .flatMap((m) => {
          const state = (
            m.payload as {
              state: { gameState?: { combatRoom?: RoomCombatState } };
            }
          ).state;
          return state.gameState?.combatRoom?.entities.map((e) => e.id) ?? [];
        });
    expect(synced(watcher.messages)).not.toContain('ent_aria');
    expect(synced(table.messages)).toContain('ent_aria');
    await room.drain();
  });

  it('broadcast: a hidden reactor with a controller never opens a private-only window', async () => {
    vi.useFakeTimers();
    const e = engaged();
    const reactorAccount = crypto.randomUUID();
    const combat: RoomCombatState = {
      ...e.state,
      entities: e.state.entities.map((entity) =>
        entity.id === 'ent_goblin-minion_1'
          ? { ...entity, hidden: true }
          : entity,
      ),
    };
    const table = memoryTable({
      ...e.game,
      combatActors: {
        [account]: 'ent_aria',
        [reactorAccount]: 'ent_goblin-minion_1',
      },
      combatRoom: combat,
    });
    const room = table.boot();
    await joinSeated(room, account, table.connection);
    const reactor = inbox();
    await joinSeated(room, reactorAccount, reactor.connection);
    table.messages.length = 0;
    reactor.messages.length = 0;
    await room.submitCombatCommand(account, crypto.randomUUID(), {
      command: 'move',
      destination: { x: 7, y: 6 },
    });
    await room.drain();
    expect(table.events.some((event) => event.type === 'MoveEnded')).toBe(true);
    const moveBatches = table.messages.filter(
      (message) =>
        message.type === 'CombatEvents' &&
        (message.payload as { events: { type: string }[] }).events.some(
          (event) => event.type === 'MoveStarted',
        ),
    );
    expect(
      moveBatches.every((message) =>
        (message.payload as { events: { type: string }[] }).events.some(
          (event) => event.type === 'MoveEnded',
        ),
      ),
    ).toBe(true);
    expect(table.events.some((event) => event.type === 'ReactionSpent')).toBe(
      false,
    );
    expect(
      table.messages.filter((m) => m.type.startsWith('ReactionPrompt')),
    ).toEqual([]);
    expect(
      reactor.messages.filter((m) => m.type.startsWith('ReactionPrompt')),
    ).toEqual([]);
    expect(eventTypes(table.messages)).not.toContain('EntityRevealed');
    expect(mentions(table.messages, 'ent_goblin-minion_1')).toBe(false);
  });

  // The engine reveals a reactor only when its reaction resolves, so a same-commit reveal
  // is injected into the move's own output: the reactor is un-hidden in the same commit.
  const sameCommitReveal = (
    runtime: ReturnType<typeof engaged>['runtime'],
    reactorId: string,
  ) => ({
    ...runtime,
    execute: (...args: Parameters<typeof runtime.execute>) => {
      const result = runtime.execute(...args);
      if ('code' in result) return result;
      const at = result.events.findIndex(
        (event) =>
          event.type === 'OpportunityTriggered' &&
          event.attackerId === reactorId,
      );
      if (at < 0) return result;
      return {
        ...result,
        state: {
          ...result.state,
          entities: result.state.entities.map((entity) =>
            entity.id === reactorId ? { ...entity, hidden: false } : entity,
          ),
        },
        events: [
          ...result.events.slice(0, at + 1),
          { type: 'EntityRevealed', entityId: reactorId, cause: 'opportunity' },
          ...result.events.slice(at + 1),
        ],
      };
    },
  });

  it('same-commit reveal: non-controllers get EntityRevealed but no reaction events', async () => {
    vi.useFakeTimers();
    const e = engaged();
    const reactorId = 'ent_goblin-minion_1';
    const reactorAccount = crypto.randomUUID();
    const other = crypto.randomUUID();
    const combat: RoomCombatState = {
      ...e.state,
      entities: e.state.entities.map((entity) =>
        entity.id === reactorId ? { ...entity, hidden: true } : entity,
      ),
    };
    const table = memoryTable({
      ...e.game,
      combatActors: { [account]: 'ent_aria', [reactorAccount]: reactorId },
      combatRoom: combat,
    });
    const room = table.boot([], sameCommitReveal(e.runtime, reactorId));
    await joinSeated(room, account, table.connection);
    const reactor = inbox();
    await joinSeated(room, reactorAccount, reactor.connection);
    const watcher = inbox();
    await joinSeated(room, other, watcher.connection);
    reactor.messages.length = 0;
    watcher.messages.length = 0;
    await room.submitCombatCommand(account, crypto.randomUUID(), {
      command: 'move',
      destination: { x: 7, y: 6 },
    });
    await room.drain();
    expect(eventTypes(watcher.messages)).toContain('EntityRevealed');
    for (const type of [
      'OpportunityTriggered',
      'ReactionAvailable',
      'ReactionResolved',
    ])
      expect(eventTypes(watcher.messages)).not.toContain(type);
    expect(watcher.messages.filter((m) => m.type === 'ReactionPrompt')).toEqual(
      [],
    );
    expect(eventTypes(reactor.messages)).toEqual(
      expect.arrayContaining([
        'EntityRevealed',
        'OpportunityTriggered',
        'ReactionAvailable',
      ]),
    );
    await room.drain();
  });

  it('same-commit reveal with no controller: no reaction events reach any seat', async () => {
    vi.useFakeTimers();
    const e = engaged();
    const reactorId = 'ent_goblin-minion_1';
    const other = crypto.randomUUID();
    const combat: RoomCombatState = {
      ...e.state,
      entities: e.state.entities.map((entity) =>
        entity.id === reactorId ? { ...entity, hidden: true } : entity,
      ),
    };
    const table = memoryTable({
      ...e.game,
      combatActors: { [account]: 'ent_aria' },
      combatRoom: combat,
    });
    const room = table.boot([], sameCommitReveal(e.runtime, reactorId));
    await joinSeated(room, account, table.connection);
    const watcher = inbox();
    await joinSeated(room, other, watcher.connection);
    watcher.messages.length = 0;
    await room.submitCombatCommand(account, crypto.randomUUID(), {
      command: 'move',
      destination: { x: 7, y: 6 },
    });
    await room.drain();
    expect(eventTypes(watcher.messages)).toContain('EntityRevealed');
    for (const type of [
      'OpportunityTriggered',
      'ReactionAvailable',
      'ReactionResolved',
    ])
      expect(eventTypes(watcher.messages)).not.toContain(type);
    await room.drain();
  });
});

describe('party reaction prompt lifecycle (ADR-033 §3, §4; ADR-034 §5)', () => {
  const leave = { command: 'move', destination: { x: 7, y: 6 } } as const;
  const names = (table: ReturnType<typeof memoryTable>) =>
    table.events.map((event) => event.type);
  const payloads = (table: ReturnType<typeof memoryTable>, type: string) =>
    table.events.filter((e) => e.type === type).map((e) => e.payload);
  const combatOf = (table: ReturnType<typeof memoryTable>) =>
    table.game().combatRoom as RoomCombatState;

  /** ent_aria walks away from a goblin; `controlled` seats a second account as the goblin's controller. */
  const stage = async (
    opts: {
      controlled?: boolean;
      hidden?: boolean;
      patch?: Partial<RoomCombatState>;
    } = {},
  ) => {
    vi.useFakeTimers();
    const e = engaged();
    const reactor = crypto.randomUUID();
    const table = memoryTable({
      ...e.game,
      combatActors: {
        [account]: 'ent_aria',
        ...(opts.controlled === false
          ? {}
          : { [reactor]: 'ent_goblin-minion_1' }),
      },
      combatRoom: {
        ...e.state,
        promptEvents: true,
        ...(opts.hidden
          ? {
              entities: e.state.entities.map((entity) =>
                entity.id === 'ent_goblin-minion_1'
                  ? { ...entity, hidden: true }
                  : entity,
              ),
            }
          : {}),
        ...opts.patch,
      },
    });
    const room = table.boot();
    await joinSeated(room, account, table.connection);
    const reactorInbox: import('@game/schema').ServerMessage[] = [];
    if (opts.controlled !== false)
      await joinSeated(room, reactor, {
        send: (m) => void reactorInbox.push(m),
      });
    await room.submitCombatCommand(account, crypto.randomUUID(), leave);
    await vi.advanceTimersByTimeAsync(0);
    return { e, table, room, reactor, reactorInbox };
  };

  it('opens a window with ReactionPromptOpened instead of ReactionAvailable', async () => {
    const { table, reactorInbox } = await stage();
    expect(names(table)).toContain('ReactionPromptOpened');
    expect(names(table)).not.toContain('ReactionAvailable');
    const opened = payloads(table, 'ReactionPromptOpened')[0]!;
    expect(opened).toMatchObject({ reactorEntityId: 'ent_goblin-minion_1' });
    expect(combatOf(table).pendingReaction).toMatchObject({
      opened: true,
      windowMs: REACTION_TIMEOUT_MS,
    });
    expect(reactorInbox.some((m) => m.type === 'ReactionPrompt')).toBe(true);
  });

  it('a hidden reactor with an assigned controller is auto-declined before any seat sees a stalled move', async () => {
    const { table, reactorInbox } = await stage({ hidden: true });
    expect(combatOf(table).pendingReaction).toBeUndefined();
    expect(names(table)).toContain('MoveEnded');
    const deliveredEvents = table.messages.flatMap((message) =>
      message.type === 'CombatEvents'
        ? (message.payload as { events: { type: string }[] }).events
        : [],
    );
    expect(
      deliveredEvents.filter((event) => event.type === 'EntityMoved'),
    ).toHaveLength(1);
    const moveBatches = table.messages.filter(
      (message) =>
        message.type === 'CombatEvents' &&
        (message.payload as { events: { type: string }[] }).events.some(
          (event) => event.type === 'MoveStarted',
        ),
    );
    expect(
      moveBatches.every((message) =>
        (message.payload as { events: { type: string }[] }).events.some(
          (event) => event.type === 'MoveEnded',
        ),
      ),
    ).toBe(true);
    expect(payloads(table, 'ReactionDeclined')).toMatchObject([
      { cause: 'auto' },
    ]);
    expect(reactorInbox.some((m) => m.type.startsWith('ReactionPrompt'))).toBe(
      false,
    );
    expect(
      table.messages.filter((m) => m.type.startsWith('ReactionPrompt')),
    ).toEqual([]);
  });

  it.each([
    ['no-controller', { controlled: false, hidden: true }],
    [
      'cap',
      {
        hidden: true,
        patch: { reactionBudgetMs: 0 } as Partial<RoomCombatState>,
      },
    ],
  ])(
    'a hidden reactor declined immediately (%s) never reaches the mover: no event, no id substring',
    async (cause, opts) => {
      const { table, reactorInbox } = await stage(opts);
      expect(payloads(table, 'ReactionDeclined')).toMatchObject([{ cause }]);
      if (cause === 'no-controller') {
        expect(combatOf(table).pendingReaction).toBeUndefined();
        expect(names(table)).toContain('MoveEnded');
        expect(names(table)).toContain('ReactionDeclined');
      }
      const wire = JSON.stringify(table.messages);
      expect(wire).not.toContain('ReactionDeclined');
      expect(wire).not.toContain('ReactionPromptOpen');
      expect(wire).not.toContain('ent_goblin-minion_1');
      // Wire prompt ids are opaque, never the engine's `<hostile>-><mover>@<cell>`.
      expect(JSON.stringify(payloads(table, 'ReactionDeclined'))).not.toContain(
        'ent_',
      );
      // Hidden reactors never receive a controller-only reaction prompt.
      if (opts.controlled !== false)
        expect(
          reactorInbox.some((m) => m.type.startsWith('ReactionPrompt')),
        ).toBe(false);
    },
  );

  it('a visible uncontrolled reactor still announces its immediate decline to everyone', async () => {
    const { table } = await stage({ controlled: false });
    expect(JSON.stringify(table.messages)).toContain('ReactionDeclined');
  });

  it('prompt ids are opaque on every wire surface', async () => {
    const { table, reactorInbox } = await stage();
    const id = promptIdOf(combatOf(table).pendingReaction!);
    expect(id).toMatch(/^rp_\d+$/);
    for (const frames of [table.messages, reactorInbox]) {
      const wire = JSON.stringify(frames);
      expect(wire).not.toMatch(/ent_[a-z0-9_-]+->/);
      expect(wire).not.toMatch(/@\d+,\d+/);
    }
    expect(JSON.stringify(reactorInbox)).toContain(id);
  });

  it('opens no TurnOpened while a reaction is pending (ADR-033 §6.6)', async () => {
    const { table, room } = await stage();
    expect(combatOf(table).pendingReaction).toBeDefined();
    expect(names(table)).not.toContain('TurnOpened');
    await vi.advanceTimersByTimeAsync(REACTION_TIMEOUT_MS - 1_000);
    expect(names(table)).not.toContain('TurnOpened');
    await room.drain();
  });

  it('the controller answers: ReactionAnswered, never ReactionResolved', async () => {
    const { table, room, reactor } = await stage();
    const prompt = combatOf(table).pendingReaction!;
    await room.submitCombatCommand(reactor, crypto.randomUUID(), {
      command: 'reaction',
      reactionId: promptIdOf(prompt),
      choice: 'take',
    });
    await room.drain();
    expect(payloads(table, 'ReactionAnswered')).toEqual([
      {
        type: 'ReactionAnswered',
        promptId: promptIdOf(prompt),
        choice: 'take',
      },
    ]);
    expect(names(table)).not.toContain('ReactionResolved');
    expect(combatOf(table).pendingReaction).toBeUndefined();
  });

  it('expiry is ReactionDeclined{timeout} and charges the open time to the 45 s budget', async () => {
    const { table, room } = await stage();
    await vi.advanceTimersByTimeAsync(REACTION_TIMEOUT_MS + 1);
    await room.drain();
    expect(payloads(table, 'ReactionDeclined')).toMatchObject([
      { cause: 'timeout' },
    ]);
    expect(names(table)).not.toContain('ReactionResolved');
    expect(combatOf(table).reactionBudgetMs).toBe(45_000 - REACTION_TIMEOUT_MS);
  });

  it('an uncontrolled reactor declines at once (no-controller) and opens no window', async () => {
    const { table } = await stage({ controlled: false });
    expect(payloads(table, 'ReactionDeclined')).toMatchObject([
      { cause: 'no-controller' },
    ]);
    expect(names(table)).not.toContain('ReactionPromptOpened');
    expect(combatOf(table).pendingReaction).toBeUndefined();
  });

  it('a spent budget declines with cap; a small remainder shortens the window', async () => {
    const capped = await stage({ patch: { reactionBudgetMs: 0 } });
    expect(payloads(capped.table, 'ReactionDeclined')).toMatchObject([
      { cause: 'cap' },
    ]);
    expect(names(capped.table)).not.toContain('ReactionPromptOpened');
    await capped.room.drain();
    vi.useRealTimers();
    const short = await stage({ patch: { reactionBudgetMs: 5_000 } });
    expect(combatOf(short.table).pendingReaction).toMatchObject({
      windowMs: 5_000,
    });
    await short.room.drain();
  });

  it('the turn clock stays frozen for the whole window and thaws with its remaining time (6b)', async () => {
    const turnMs = 90_000;
    const { table, room } = await stage({
      patch: {
        turnId: 'turn-1',
        narrationAttempts: 0,
        turnDeadline: Date.now() + turnMs,
      },
    });
    const open = combatOf(table);
    expect(open.turnDeadline).toBeUndefined();
    expect(open.turnTimerRemainingMs).toBeGreaterThan(turnMs - 1_000);
    await vi.advanceTimersByTimeAsync(REACTION_TIMEOUT_MS + 1);
    await room.drain();
    expect(names(table)).not.toContain('TurnTimedOut');
    const thawed = combatOf(table);
    expect(thawed.turnTimerRemainingMs).toBeUndefined();
    expect(thawed.turnDeadline! - Date.now()).toBeGreaterThan(turnMs - 2_000);
  });

  it('a pause freezes the window and its budget; resuming restores the remaining time', async () => {
    const { table, room } = await stage();
    await vi.advanceTimersByTimeAsync(4_000);
    await room.setPaused(account, true, true);
    expect(combatOf(table).pendingReaction?.frozenMs).toBe(
      REACTION_TIMEOUT_MS - 4_000,
    );
    await vi.advanceTimersByTimeAsync(60_000);
    expect(names(table)).not.toContain('ReactionDeclined');
    await room.setPaused(account, false, true);
    expect(combatOf(table).pendingReaction?.frozenMs).toBeUndefined();
    await vi.advanceTimersByTimeAsync(REACTION_TIMEOUT_MS - 4_000 + 1);
    await room.drain();
    expect(payloads(table, 'ReactionDeclined')).toMatchObject([
      { cause: 'timeout' },
    ]);
    // 4 s before the pause + 11 s after: the 60 s frozen gap is not charged.
    expect(combatOf(table).reactionBudgetMs).toBe(45_000 - REACTION_TIMEOUT_MS);
  });

  it('a restart closes the open window as ReactionDeclined{restart}', async () => {
    const { table, room } = await stage();
    await room.drain();
    const second = table.boot();
    await vi.advanceTimersByTimeAsync(10);
    await second.drain();
    expect(payloads(table, 'ReactionDeclined')).toMatchObject([
      { cause: 'restart' },
    ]);
  });

  it('CombatEnded closes an open prompt as ReactionDeclined{combat-ended} and ends the move', () => {
    const e = engaged();
    const moved = ok(
      e.runtime.execute({ ...e.state, promptEvents: true }, 'ent_aria', leave, {
        now: NOW,
      }),
    );
    const opened = {
      ...moved.state,
      pendingReaction: {
        ...moved.state.pendingReaction!,
        opened: true as const,
      },
    };
    const ended = settle({
      ...opened,
      entities: opened.entities.map((entity) =>
        entity.team === 'enemies' ? { ...entity, hp: 0 } : entity,
      ),
    });
    expect(types(ended.events)).toEqual([
      'ReactionDeclined',
      'MoveEnded',
      'CombatEnded',
    ]);
    expect(ended.state.pendingReaction).toBeUndefined();
  });
});

describe('interrupted move is re-checked before it resumes (ADR-033 §4.3-4.5)', () => {
  const provoked = () => {
    const e = engaged();
    const moved = ok(
      e.runtime.execute(
        e.state,
        'ent_aria',
        { command: 'move', destination: { x: 7, y: 6 } },
        { now: NOW },
      ),
    );
    const prompt = moved.state.pendingReaction!;
    const next =
      moved.state.engineReactions![prompt.reactionId]!.remainingPath[0]!;
    const decline = (state: RoomCombatState) =>
      ok(
        e.runtime.execute(
          state,
          prompt.entityId,
          {
            command: 'reaction',
            reactionId: prompt.reactionId,
            choice: 'decline',
          },
          { now: NOW + 1000 },
        ),
      );
    return { moved, next, decline };
  };
  const stops = (
    result: { state: RoomCombatState; events: Record<string, unknown>[] },
    from: RoomCombatState,
  ) => {
    const here = (s: RoomCombatState) =>
      s.entities.find((entity) => entity.id === 'ent_aria')!.pos;
    expect(here(result.state)).toEqual(here(from));
    expect(
      result.events.find((event) => event.type === 'MoveEnded'),
    ).toMatchObject({ entityId: 'ent_aria', reason: 'blocked' });
  };

  it('stops when a later step has been occupied meanwhile', () => {
    const { moved, next, decline } = provoked();
    const occupied = {
      ...moved.state,
      entities: moved.state.entities.map((entity) =>
        entity.id === 'ent_goblin-minion_2' ? { ...entity, pos: next } : entity,
      ),
    };
    stops(decline(occupied), moved.state);
  });

  it('stops when the remaining speed no longer covers the next step, forfeiting the rest', () => {
    const { moved, decline } = provoked();
    const slowed = {
      ...moved.state,
      combat: {
        ...moved.state.combat,
        resources: {
          ...moved.state.combat.resources,
          ent_aria: {
            ...moved.state.combat.resources.ent_aria!,
            movementRemaining: 0,
          },
        },
      },
    };
    stops(decline(slowed), moved.state);
  });

  it('stops when the mover is down (incapacitated)', () => {
    const { moved, decline } = provoked();
    const down = {
      ...moved.state,
      entities: moved.state.entities.map((entity) =>
        entity.id === 'ent_aria' ? { ...entity, hp: 0 } : entity,
      ),
    };
    const result = decline(down);
    expect(
      result.events.find((event) => event.type === 'MoveEnded'),
    ).toMatchObject({ reason: 'incapacitated' });
  });
});

describe('combat started by a DM turn (reconcile) in party mode', () => {
  it('marks the encounter for the prompt lifecycle and emits no legacy reaction events', () => {
    const seat = crypto.randomUUID();
    const bindings = new Map([[seat, { characterSnapshot: { ...hero } }]]);
    const game = partyCombat(7, { [account]: hero }, bindings);
    const room = (game as { combatRoom: RoomCombatState }).combatRoom;
    expect(room.promptEvents).toBe(true);
    // Sandbox/solo bootstrap keeps the M2 events: no flag.
    expect(bootstrapped().state.promptEvents).toBeUndefined();
  });
});

describe('answers only from an open window; prompt id counter (ADR-033 §3)', () => {
  const leave = { command: 'move', destination: { x: 7, y: 6 } } as const;
  const provokedParty = (seed?: number) => {
    const e = engaged();
    const moved = ok(
      e.runtime.execute(
        {
          ...e.state,
          promptEvents: true,
          ...(seed === undefined ? {} : { promptSeq: seed }),
        },
        'ent_aria',
        leave,
        { now: NOW },
      ),
    );
    return { ...e, moved };
  };

  it('rejects an answer to a prompt that has not been announced, with no state change', () => {
    const { runtime, moved } = provokedParty();
    const prompt = moved.state.pendingReaction!;
    expect(prompt.opened).toBeUndefined();
    expect(prompt.promptId).toBe('rp_1'); // guessable counter, reactor identity correct
    const before = JSON.stringify(moved.state);
    const result = runtime.execute(
      moved.state,
      prompt.entityId,
      { command: 'reaction', reactionId: 'rp_1', choice: 'take' },
      { now: NOW + 1 },
    );
    expect(result).toMatchObject({ code: 'COMMAND_REJECTED' });
    expect(JSON.stringify(moved.state)).toBe(before);
    // Once announced the same answer is accepted.
    const opened = {
      ...moved.state,
      pendingReaction: { ...prompt, opened: true as const },
    };
    const accepted = ok(
      runtime.execute(
        opened,
        prompt.entityId,
        { command: 'reaction', reactionId: 'rp_1', choice: 'decline' },
        { now: NOW + 1 },
      ),
    );
    expect(types(accepted.events)).toContain('ReactionAnswered');
  });

  it('an old state without promptSeq starts at rp_1; the counter then advances', () => {
    expect(provokedParty().moved.state.promptSeq).toBe(1);
    expect(provokedParty(6).moved.state.pendingReaction?.promptId).toBe('rp_7');
  });

  it('a rewound state keeps the higher prompt counter so ids are never reused', () => {
    const at = (promptSeq?: number) => ({
      combatRoom: promptSeq === undefined ? {} : { promptSeq },
    });
    const seqOf = (g: unknown) =>
      (g as { combatRoom: { promptSeq?: number } }).combatRoom.promptSeq;
    expect(seqOf(carryPromptSeq(at(2), at(5)))).toBe(5);
    expect(seqOf(carryPromptSeq(at(7), at(5)))).toBe(7);
    expect(seqOf(carryPromptSeq(at(), at(3)))).toBe(3);
    expect(carryPromptSeq({}, at(3))).toEqual({});
  });
});
