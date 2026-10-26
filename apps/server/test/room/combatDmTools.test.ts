import { describe, expect, it } from 'vitest';
import {
  consumeOptionHandle,
  runCombatMapTool,
} from '../../src/room/combatDmTools.js';
import { runMonsters } from '../../src/room/combatEngine.js';
import { advanceTurn } from '../../src/room/combatEngine.js';
import { bootstrapped, catalog, hero, placed } from './combatFixtures.js';

const env = { catalog, actors: { [hero.id]: hero } };
const move = (targetRef: string, entityId = hero.id) => ({
  name: 'move_to' as const,
  args: { entityId, targetRef, mode: 'within' },
});
const area = {
  name: 'suggest_area_target' as const,
  args: {
    spellId: 'srd:spell/burning-hands',
    casterId: hero.id,
    intent: 'max-enemies',
  },
};
/** Aria's turn, goblins out of reach so movement provokes nothing. */
function ariaTurn() {
  const b = bootstrapped();
  return placed(b.state, {
    ent_aria: { x: 7, y: 2 },
    'ent_goblin-minion_1': { x: 12, y: 16 },
    'ent_goblin-minion_2': { x: 13, y: 16 },
  });
}

describe('DM map tools against Room combatRoom', () => {
  it('move_to resolves a marker through engine pathing and persists position and spent movement', () => {
    const room = ariaTurn();
    const before = structuredClone(room);
    const out = runCombatMapTool(room, move('mk_entrance'), env);
    expect(out.result.ok).toBe(true);
    const aria = out.room.entities.find((e) => e.id === hero.id)!;
    expect(aria.pos).toEqual({ x: 9, y: 1 });
    expect(out.room.combat.resources[hero.id]!.movementRemaining).toBeLessThan(
      room.combat.resources[hero.id]!.movementRemaining,
    );
    expect(room).toEqual(before);
  });

  it('rejected calls return the identical room', () => {
    const room = ariaTurn();
    for (const call of [
      move('mk_nowhere'),
      move('mk_entrance', 'ent_goblin-minion_1'),
      {
        name: 'move_to' as const,
        args: {
          entityId: hero.id,
          targetRef: 'mk_altar',
          mode: 'within',
          x: 3,
        },
      },
    ]) {
      const out = runCombatMapTool(room, call, env);
      expect(out.result.ok).toBe(false);
      expect(out.room).toBe(room);
    }
  });

  it('cannot name a hidden entity as a destination', () => {
    const room = ariaTurn();
    const hiddenRoom = {
      ...room,
      entities: room.entities.map((e) =>
        e.id === 'ent_goblin-minion_1' ? { ...e, hidden: true } : e,
      ),
    };
    const out = runCombatMapTool(hiddenRoom, move('ent_goblin-minion_1'), env);
    expect(out.result.ok).toBe(false);
    expect(out.room).toBe(hiddenRoom);
  });

  it('hidden goblin in reach is refused in adjacent mode with the same generic error as an unknown id', () => {
    const room = placed(ariaTurn(), { 'ent_goblin-minion_1': { x: 8, y: 2 } });
    const hiddenRoom = {
      ...room,
      entities: room.entities.map((e) =>
        e.id === 'ent_goblin-minion_1' ? { ...e, hidden: true } : e,
      ),
    };
    const adjacent = (targetRef: string) => ({
      name: 'move_to' as const,
      args: { entityId: hero.id, targetRef, mode: 'adjacent' },
    });
    const hidden = runCombatMapTool(
      hiddenRoom,
      adjacent('ent_goblin-minion_1'),
      env,
    );
    const unknown = runCombatMapTool(hiddenRoom, adjacent('ent_nobody'), env);
    expect(hidden.result.ok).toBe(false);
    expect(hidden.room).toBe(hiddenRoom);
    const shape = (r: { error?: string; hint?: string }, ref: string) => ({
      error: r.error,
      hint: r.hint?.replace(ref, '<ref>'),
    });
    expect(shape(hidden.result as never, 'ent_goblin-minion_1')).toEqual(
      shape(unknown.result as never, 'ent_nobody'),
    );
  });

  describe('opportunity-attack refusal does not reveal hidden hostiles', () => {
    const hide = (r: ReturnType<typeof ariaTurn>, ...ids: string[]) => ({
      ...r,
      entities: r.entities.map((e) =>
        ids.includes(e.id) ? { ...e, hidden: true } : e,
      ),
    });
    const reply = (r: { result: unknown }) => {
      const x = r.result as { ok: boolean; error?: string; hint?: string };
      return { ok: x.ok, error: x.error, hint: x.hint };
    };
    const oa = 'That route would provoke an opportunity attack';

    it('(a) hidden-only blocker gives the unknown-destination error and hint', () => {
      const room = hide(
        placed(ariaTurn(), { 'ent_goblin-minion_1': { x: 6, y: 2 } }),
        'ent_goblin-minion_1',
      );
      const out = runCombatMapTool(room, move('mk_entrance'), env);
      expect(out.room).toBe(room);
      expect(reply(out)).toEqual({
        ok: false,
        error: 'unreachable',
        hint: 'No entity, marker, feature, or current option matches mk_entrance.',
      });
      const unknown = reply(runCombatMapTool(room, move('mk_nowhere'), env));
      expect(reply(out)).toEqual({
        ...unknown,
        hint: unknown.hint?.replace('mk_nowhere', 'mk_entrance'),
      });
    });

    it('(b) visible-only blocker gives the opportunity-attack message', () => {
      const room = placed(ariaTurn(), {
        'ent_goblin-minion_1': { x: 6, y: 2 },
      });
      const out = runCombatMapTool(room, move('mk_entrance'), env);
      expect(out.room).toBe(room);
      expect(reply(out).hint).toContain(oa);
    });

    it('(c) mixed visible and hidden blockers behave as visible-only', () => {
      const visibleOnly = placed(ariaTurn(), {
        'ent_goblin-minion_1': { x: 6, y: 2 },
      });
      const mixed = hide(
        placed(ariaTurn(), {
          'ent_goblin-minion_1': { x: 6, y: 2 },
          'ent_goblin-minion_2': { x: 6, y: 2 },
        }),
        'ent_goblin-minion_2',
      );
      expect(reply(runCombatMapTool(mixed, move('mk_entrance'), env))).toEqual(
        reply(runCombatMapTool(visibleOnly, move('mk_entrance'), env)),
      );
    });

    it('(d) a route with no goblin in reach is accepted', () => {
      const out = runCombatMapTool(ariaTurn(), move('mk_entrance'), env);
      expect(out.result.ok).toBe(true);
    });
  });

  it('refuses a route that would open a reaction window', () => {
    const room = placed(ariaTurn(), { 'ent_goblin-minion_1': { x: 6, y: 2 } });
    const out = runCombatMapTool(room, move('mk_entrance'), env);
    expect(out.result.ok).toBe(false);
    expect(out.room).toBe(room);
  });

  it('area aim issues turn-bound handles that previews list, hidden units omitted, and ', () => {
    const room = placed(ariaTurn(), {
      'ent_goblin-minion_1': { x: 8, y: 2 },
      'ent_goblin-minion_2': { x: 9, y: 2 },
    });
    const hiddenRoom = {
      ...room,
      entities: room.entities.map((e) =>
        e.id === 'ent_goblin-minion_2' ? { ...e, hidden: true } : e,
      ),
    };
    const out = runCombatMapTool(hiddenRoom, area, env);
    expect(out.result.ok).toBe(true);
    const handles = out.room.optionHandles!;
    expect(Object.keys(handles).length).toBeGreaterThan(0);
    const shown = JSON.stringify(out.result);
    expect(shown).not.toContain('ent_goblin-minion_2');
    expect(Object.values(handles).flatMap((h) => h.affected)).not.toContain(
      'ent_goblin-minion_2',
    );
    expect(Object.values(handles).map((h) => h.affected)).toContainEqual([
      'ent_goblin-minion_1',
    ]);
    const later = runCombatMapTool({ ...out.room, turnId: 'later' }, area, env);
    expect(
      Object.values(later.room.optionHandles!).every(
        (h) => h.expiresTurn === 'later',
      ),
    ).toBe(true);
    // handles are DM-only: move_to takes no option reference (schema rejects it; engine finds no match)
    const viaOption = runCombatMapTool(
      out.room,
      move(Object.keys(handles)[0]!),
      env,
    );
    expect(viaOption.result.ok).toBe(false);
  });

  it('replays identically', () => {
    const run = () => runCombatMapTool(ariaTurn(), move('mk_entrance'), env);
    expect(run()).toEqual(run());
  });
});

describe('area option handles are single-use and end with the turn', () => {
  it('consumeOptionHandle spends only the used handle', () => {
    const room = runCombatMapTool(
      placed(ariaTurn(), { 'ent_goblin-minion_1': { x: 8, y: 2 } }),
      area,
      env,
    ).room;
    const [first, ...others] = Object.keys(room.optionHandles!);
    const spent = consumeOptionHandle(room, first!);
    expect(spent.optionHandles).not.toHaveProperty(first!);
    expect(Object.keys(spent.optionHandles!)).toEqual(others);
  });

  it('advancing the turn clears every handle', () => {
    const room = runCombatMapTool(ariaTurn(), area, env).room;
    expect(Object.keys(room.optionHandles!).length).toBeGreaterThan(0);
    expect(advanceTurn(room).state.optionHandles).toBeUndefined();
  });
});

describe('monster turns in Room combat', () => {
  it('follow the engine monster policy and replay identically from the same seed', () => {
    const base = ariaTurn();
    const handoff = advanceTurn(base).state;
    const a = runMonsters(handoff, 5_000);
    const b = runMonsters(structuredClone(handoff), 5_000);
    expect(a).toEqual(b);
    expect(a.events.some((e) => e.type === 'MonsterPolicy')).toBe(true);
  });
});
