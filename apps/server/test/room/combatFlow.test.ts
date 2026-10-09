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

afterEach(() => vi.useRealTimers());

const NOW = 1_000_000;
const types = (events: readonly Record<string, unknown>[]) =>
  events.map((event) => String(event.type));
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
    ).toMatchObject({ code: 'NOT_YOUR_TURN' });
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
    ).toMatchObject({ code: 'COMMAND_REJECTED' });
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

describe('opportunity attack reactions', () => {
  const leave = { command: 'move', destination: { x: 7, y: 6 } } as const;
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
  });

  it('refuses every other command while the prompt is open', () => {
    const { runtime, moved } = provoke();
    expect(
      runtime.execute(moved.state, 'ent_aria', { command: 'end-turn' }),
    ).toMatchObject({ code: 'COMMAND_REJECTED' });
  });

  it('accept: the goblin spends its reaction on an engine-resolved attack and the move continues', () => {
    const { runtime, moved } = provoke();
    const taken = ok(
      runtime.execute(
        moved.state,
        'ent_aria',
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
    expect(taken.state.combat.resources['ent_goblin-minion_1']?.reaction).toBe(
      false,
    );
    expect(taken.state.entities.find((e) => e.id === 'ent_aria')!.pos).toEqual({
      x: 7,
      y: 6,
    });
  });

  it('decline: no attack is made and the move continues', () => {
    const { runtime, moved } = provoke();
    const declined = ok(
      runtime.execute(
        moved.state,
        'ent_aria',
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

  it('is idempotent: answering a resolved reaction is rejected without change', () => {
    const { runtime, moved } = provoke();
    const reactionId = moved.state.pendingReaction!.reactionId;
    const done = ok(
      runtime.execute(moved.state, 'ent_aria', {
        command: 'reaction',
        reactionId,
        choice: 'decline',
      }),
    );
    const again = runtime.execute(done.state, 'ent_aria', {
      command: 'reaction',
      reactionId,
      choice: 'take',
    });
    expect(again).toMatchObject({ code: 'COMMAND_REJECTED' });
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
    await room.join(account, table.connection);
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

  it('a restart mid-prompt resumes with the remaining time, then declines', async () => {
    vi.useFakeTimers();
    const { table } = await stage();
    const first = table.boot();
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
    await room.join(account, table.connection);
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
