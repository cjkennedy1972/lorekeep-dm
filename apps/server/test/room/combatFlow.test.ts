import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  combatTracker,
  REACTION_TIMEOUT_MS,
  type RoomCombatState,
} from '../../src/room/combat.js';
import {
  account,
  bootstrapped,
  catalog,
  hero,
  memoryTable,
  placed,
} from './combatFixtures.js';
import { joinSeated } from '../helpers/room.js';
import { settle } from '../../src/room/combatEngine.js';

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

describe('combat bootstrap from the DM start_combat result', () => {
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
      /^\[Combat resolved by the engine; narrate it, do not change it\] (\{[^]*\})?$/,
    );
    expect(requests[0]!.playerName).toBe('Combat');
    expect(table.events.some((event) => event.type === 'TurnOpened')).toBe(
      false,
    );
    expect(ended.phase).toBeUndefined();
    expect(ended.turnId).toBeUndefined();
    expect(ended.turnDeadline).toBeUndefined();
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
      async run(request: unknown) {
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

  it('excludes hidden-entity facts from recovered combat narration input', async () => {
    const e = bootstrapped();
    let promptText = '';
    const runner = {
      async run(request: unknown) {
        promptText = String((request as { text?: unknown }).text ?? '');
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
    });
    expect(
      table.events.filter((event) => event.type === 'NarrationCommitted'),
    ).toHaveLength(1);
    expect(
      table.events.filter((event) => event.type === 'TurnOpened'),
    ).toHaveLength(1);
  });
});
