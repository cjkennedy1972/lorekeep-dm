import { describe, expect, it } from 'vitest';
import { runCombatMapTool } from '../../src/room/combatDmTools.js';
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

  it('refuses a route that would open a reaction window', () => {
    const room = placed(ariaTurn(), { 'ent_goblin-minion_1': { x: 6, y: 2 } });
    const out = runCombatMapTool(room, move('mk_entrance'), env);
    expect(out.result.ok).toBe(false);
    expect(out.room).toBe(room);
  });

  it('area aim issues turn-bound handles that previews list, hidden units omitted, and move_to accepts only while fresh', () => {
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
    // an option reference is a well-formed move_to destination, resolved by the engine (not a coordinate)
    const viaOption = runCombatMapTool(
      out.room,
      move(Object.keys(handles)[0]!),
      env,
    );
    expect(JSON.stringify(viaOption.result)).not.toContain('schema-violation');
  });

  it('replays identically', () => {
    const run = () => runCombatMapTool(ariaTurn(), move('mk_entrance'), env);
    expect(run()).toEqual(run());
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
