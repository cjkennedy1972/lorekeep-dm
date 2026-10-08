import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Battlemap, GridPos } from '@game/schema';
import { loadCatalog } from '../catalog/load.js';
import { loadAuthoredMap } from '../map/load.js';
import { reachable } from '../map/reachable.js';
import { distance } from '../map/geometry.js';
import {
  Sim,
  abilities,
  type SimEntity,
  type SimLog,
  type SimSpec,
} from './sim.js';

const catalog = loadCatalog();
const readMap = (name: string): unknown =>
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL(`../../maps/${name}.json`, import.meta.url)),
      'utf8',
    ),
  );
function validated(json: unknown): Battlemap {
  const res = loadAuthoredMap(json);
  if (!res.ok)
    throw new Error(`Invalid map: ${res.errors.map((e) => e.message).join()}`);
  return res.map;
}
const crypt = () => validated(readMap('crypt-room'));
const forest = () => validated(readMap('forest-clearing'));
/** Crypt with a wall across the middle (y=11|12) and one closed door at x=9. */
function partitionedCrypt(): Battlemap {
  const json = readMap('crypt-room') as Record<string, unknown> & {
    edges: unknown[];
  };
  const edges: unknown[] = [...json.edges];
  for (let x = 1; x <= 18; x++)
    edges.push({
      a: { x, y: 11 },
      b: { x, y: 12 },
      kind: x === 9 ? 'door' : 'wall',
      ...(x === 9 ? { state: 'closed' } : {}),
    });
  return validated({ ...json, mapId: 'crypt-partition', edges });
}

/** Foe/ally stats come from the shipped SRD catalog, not hand-typed numbers. */
function monster(
  catalogId: string,
  id: string,
  pos: GridPos,
  opts: { team?: 'pc' | 'foe'; ranged?: boolean } = {},
): SimSpec {
  const m = catalog.get('monster', catalogId);
  if (
    !m ||
    m.kind !== 'monster' ||
    !m.attacks ||
    !m.abilities ||
    !m.footprint ||
    !m.speed
  )
    throw new Error(`incomplete monster ${catalogId}`);
  const pick =
    (opts.ranged ? m.attacks.find((a) => a.range) : undefined) ??
    m.attacks.find((a) => a.reachFt) ??
    m.attacks[0]!;
  return {
    id,
    team: opts.team ?? 'foe',
    pos,
    size: m.footprint,
    hp: m.hp,
    ac: m.ac,
    speed: m.speed,
    abilities: m.abilities,
    attackBonus: pick.toHit,
    damage: pick.damage[0]!.dice,
    damageType: pick.damage[0]!.type,
    ...(opts.ranged && pick.range
      ? {
          range: {
            normalFt: pick.range.normalFt,
            longFt: pick.range.longFt ?? pick.range.normalFt,
          },
        }
      : {}),
  };
}
const fighter = (id: string, pos: GridPos): SimSpec => ({
  id,
  team: 'pc',
  pos,
  size: 1,
  hp: 13,
  ac: 16,
  speed: 30,
  abilities: abilities({ str: 16, dex: 12, con: 14 }),
  attackBonus: 5,
  damage: '1d8+3',
  damageType: 'slashing',
  saveProficiencies: ['str', 'con'],
});
const archer = (id: string, pos: GridPos): SimSpec => ({
  id,
  team: 'pc',
  pos,
  size: 1,
  hp: 11,
  ac: 14,
  speed: 30,
  abilities: abilities({ str: 10, dex: 16, con: 12 }),
  attackBonus: 5,
  damage: '1d6+3',
  damageType: 'piercing',
  range: { normalFt: 80, longFt: 320 },
  saveProficiencies: ['str', 'dex'],
});
const wizard = (
  id: string,
  pos: GridPos,
  level: number,
  slots: Record<string, number>,
): SimSpec => ({
  id,
  team: 'pc',
  pos,
  size: 1,
  hp: 6 + (level - 1) * 5,
  ac: 12,
  speed: 30,
  abilities: abilities({ int: 16, dex: 14, con: 14 }),
  attackBonus: 2,
  damage: '1d4',
  damageType: 'bludgeoning',
  saveProficiencies: ['int', 'wis'],
  caster: { classId: 'class:wizard', level, slots },
});
const cleric = (id: string, pos: GridPos, hp = 11): SimSpec => ({
  id,
  team: 'pc',
  pos,
  size: 1,
  hp,
  ac: 16,
  speed: 30,
  abilities: abilities({ wis: 16, str: 12, con: 14 }),
  attackBonus: 3,
  damage: '1d6+1',
  damageType: 'bludgeoning',
  saveProficiencies: ['wis', 'cha'],
  caster: { classId: 'class:cleric', level: 1, slots: { '1': 2 } },
});

const nearest = (sim: Sim, e: SimEntity) =>
  [...sim.opponents(e)].sort(
    (a, b) =>
      distance(e, a, sim.map.diagonalRule) -
        distance(e, b, sim.map.diagonalRule) || a.id.localeCompare(b.id),
  );

/** Kite: back off from anything adjacent (provoking), then shoot the closest visible target. */
function kiteTurn(sim: Sim, e: SimEntity) {
  const foes = nearest(sim, e);
  if (!foes.length) return;
  if (distance(e, foes[0]!, sim.map.diagonalRule) <= 5) {
    const cells = reachable(
      {
        map: sim.map,
        entities: sim.state.entities
          .filter((x) => x.hp > 0)
          .map((x) => ({ id: x.id, team: x.team, pos: x.pos, size: x.size })),
        resources: { [e.id]: { movementLeft: sim.movementOf(e.id) } },
        conditions: Object.fromEntries(
          sim.state.entities.map((x) => [x.id, x.conditions]),
        ),
      },
      e.id,
    );
    if (!('error' in cells)) {
      const score = (c: GridPos) =>
        Math.min(
          ...foes.map((f) =>
            distance({ pos: c, size: 1 }, f, sim.map.diagonalRule),
          ),
        );
      const best = [...cells].sort(
        (a, b) =>
          score(b.cell) - score(a.cell) ||
          a.cost - b.cost ||
          a.cell.y - b.cell.y ||
          a.cell.x - b.cell.x,
      )[0];
      if (best && best.path.length > 1) {
        // Disengage uses the action: back off without provoking, shoot next turn.
        sim.emit({ type: 'Disengaged', entityId: e.id });
        sim.move(e.id, best.path, 'disengage');
        return;
      }
    }
  }
  if (sim.get(e.id).hp <= 0) return;
  for (const f of nearest(sim, sim.get(e.id)))
    if (!('error' in sim.shoot(e.id, f.id))) return;
}

/** Walk next to the closest door cell and open it when the way to the foes is shut. */
function doorTurn(door: { a: GridPos; b: GridPos }) {
  return (sim: Sim, e: SimEntity) => {
    if (sim.doorIsClosed(door.a, door.b)) {
      const route = sim.routeTo(e.id, door.b);
      const adjacent =
        distance(e, { pos: door.a, size: 1 }, sim.map.diagonalRule) <= 5 ||
        distance(e, { pos: door.b, size: 1 }, sim.map.diagonalRule) <= 5;
      if (!adjacent && route) sim.moveWithinBudget(e.id, route);
      if (!('error' in sim.openDoor(e.id, door.a, door.b))) {
        // fall through: the opened door lets the normal policy run
      }
    }
    sim.policyTurn(sim.get(e.id));
  };
}

export type M2Scenario = {
  name: string;
  /** What the scenario is for, and the seed whose golden log is reviewed. */
  purpose: string;
  seed: number;
  run: (seed: number) => SimLog;
};

/** Foes flee at half HP; player characters stand and fight. */
const policy = (sim: Sim, e: SimEntity) =>
  sim.policyTurn(e, e.team === 'foe' ? { fleeBelow: 0.5 } : {});

export const M2_SCENARIOS: M2Scenario[] = [
  {
    name: 'kiting-cover-v1',
    purpose:
      'Archer kites two goblin warriors around the crypt pillars; surviving goblins take approach/attack/flee policy turns.',
    seed: 3101,
    run(seed) {
      const sim = new Sim('kiting-cover-v1', seed, crypt(), [
        archer('pc-wren', { x: 14, y: 16 }),
        monster('monster:goblin-warrior', 'goblin-1', { x: 8, y: 2 }),
        monster('monster:goblin-warrior', 'goblin-2', { x: 14, y: 2 }),
      ]);
      return sim.run(
        (s, e) => (e.team === 'pc' ? kiteTurn(s, e) : policy(s, e)),
        { maxRounds: 10 },
      );
    },
  },
  {
    name: 'door-rubble-v1',
    purpose:
      'Closed door in a partition wall plus the crypt rubble: foes cannot path until a PC opens the door, then cross difficult terrain.',
    seed: 3102,
    run(seed) {
      const door = { a: { x: 9, y: 11 }, b: { x: 9, y: 12 } };
      const sim = new Sim('door-rubble-v1', seed, partitionedCrypt(), [
        fighter('pc-garrick', { x: 8, y: 15 }),
        archer('pc-wren', { x: 10, y: 16 }),
        monster('monster:skeleton', 'skeleton-1', { x: 8, y: 4 }),
        monster('monster:zombie', 'zombie-1', { x: 11, y: 5 }),
      ]);
      return sim.run(
        (s, e) => (e.team === 'pc' ? doorTurn(door)(s, e) : policy(s, e)),
        { maxRounds: 12 },
      );
    },
  },
  {
    name: 'concentration-v1',
    purpose:
      'Wizard concentrates on Hideous Laughter; a goblin hits the wizard, forcing a concentration save that (at the reviewed seed) fails and frees the target.',
    seed: 3103,
    run(seed) {
      const sim = new Sim('concentration-v1', seed, crypt(), [
        wizard('pc-merel', { x: 9, y: 4 }, 3, { '1': 4, '2': 2 }),
        fighter('pc-garrick', { x: 7, y: 5 }),
        monster('monster:goblin-warrior', 'goblin-1', { x: 9, y: 10 }),
        monster('monster:goblin-warrior', 'goblin-2', { x: 11, y: 6 }),
        monster('monster:wolf', 'wolf-1', { x: 14, y: 9 }),
      ]);
      return sim.run(
        (s, e) => {
          if (e.team === 'foe') return policy(s, e);
          if (e.caster) {
            const target = nearest(s, e).find(
              (f) =>
                distance(e, f, s.map.diagonalRule) <= 30 && f.id === 'goblin-1',
            );
            if (target && !e.concentration) {
              const r = s.cast(
                e.id,
                'spell:hideous-laughter',
                1,
                { id: target.id },
                ['incapacitated', 'prone'],
              );
              if (!('error' in r)) return;
            }
            for (const f of nearest(s, e)) {
              if (distance(e, f, s.map.diagonalRule) > 120) continue;
              if (
                !('error' in s.cast(e.id, 'spell:fire-bolt', 0, { id: f.id }))
              )
                return;
            }
            return;
          }
          policy(s, e);
        },
        { maxRounds: 10 },
      );
    },
  },
  {
    name: 'fireball-partial-v1',
    purpose:
      'Level-5 wizard fireballs a goblin cluster on the forest map: some goblins are outside the 20 ft sphere and untouched, inside ones save for half or full damage.',
    seed: 3104,
    run(seed) {
      const sim = new Sim('fireball-partial-v1', seed, forest(), [
        wizard('pc-merel', { x: 12, y: 10 }, 5, { '1': 4, '2': 3, '3': 2 }),
        fighter('pc-garrick', { x: 14, y: 10 }),
        monster('monster:goblin-warrior', 'goblin-1', { x: 12, y: 3 }),
        monster('monster:goblin-warrior', 'goblin-2', { x: 13, y: 4 }),
        monster('monster:goblin-warrior', 'goblin-3', { x: 14, y: 3 }),
        monster('monster:goblin-warrior', 'goblin-4', { x: 21, y: 3 }),
        monster('monster:goblin-warrior', 'goblin-5', { x: 22, y: 4 }),
      ]);
      let opened = false;
      return sim.run(
        (s, e) => {
          if (e.team === 'foe') return policy(s, e);
          if (e.caster && !opened) {
            opened = true;
            const r = s.cast(e.id, 'spell:fireball', 3, {
              anchor: { x: 13, y: 4 },
            });
            if (!('error' in r)) return;
          }
          if (e.caster) {
            for (const f of nearest(s, e))
              if (
                !('error' in s.cast(e.id, 'spell:fire-bolt', 0, { id: f.id }))
              )
                return;
            return;
          }
          policy(s, e);
        },
        { maxRounds: 12 },
      );
    },
  },
  {
    name: 'death-saves-stable-v1',
    purpose:
      'A cleric begins the fight dying at 0 HP while the fighter handles a goblin out of reach; death saves accumulate to stable (3 successes).',
    seed: 3105,
    run(seed) {
      const sim = new Sim('death-saves-stable-v1', seed, crypt(), [
        { ...cleric('pc-ines', { x: 3, y: 3 }), startsDying: true },
        fighter('pc-garrick', { x: 10, y: 8 }),
        monster('monster:goblin-warrior', 'goblin-1', { x: 14, y: 11 }),
      ]);
      return sim.run(policy, { maxRounds: 12 });
    },
  },
  {
    name: 'death-saves-dead-v1',
    purpose:
      'The same dying cleric, but a goblin stands next to her and attacks: a hit at 0 HP from within 5 ft is a crit death-save failure, so she dies.',
    seed: 3106,
    run(seed) {
      const sim = new Sim('death-saves-dead-v1', seed, crypt(), [
        { ...cleric('pc-ines', { x: 3, y: 3 }), startsDying: true },
        fighter('pc-garrick', { x: 12, y: 10 }),
        monster('monster:goblin-warrior', 'goblin-1', { x: 4, y: 3 }),
      ]);
      return sim.run(
        (s, e) => {
          if (e.id === 'goblin-1') {
            const down = s.get('pc-ines');
            if (down.status === 'dying') {
              s.melee(e.id, down.id);
              return;
            }
          }
          policy(s, e);
        },
        { maxRounds: 12 },
      );
    },
  },
  {
    name: 'grapple-prone-v1',
    purpose:
      'A bandit grapples the fighter (speed 0, cannot walk away) while a wolf bite knocks the archer prone (doubled movement, melee attackers get advantage, standing costs half speed).',
    seed: 3107,
    run(seed) {
      const sim = new Sim('grapple-prone-v1', seed, crypt(), [
        fighter('pc-garrick', { x: 9, y: 8 }),
        archer('pc-wren', { x: 6, y: 9 }),
        monster('monster:bandit', 'bandit-1', { x: 9, y: 11 }),
        monster('monster:wolf', 'wolf-1', { x: 6, y: 12 }),
      ]);
      return sim.run(
        (s, e) => {
          const foes = nearest(s, e);
          const adjacent = foes.find(
            (f) => distance(e, f, s.map.diagonalRule) <= 5,
          );
          if (
            e.id === 'bandit-1' &&
            adjacent &&
            !adjacent.conditions.some((c) => c.id === 'grappled')
          ) {
            s.contest(e.id, adjacent.id, 'grappled');
            return;
          }
          if (e.id === 'wolf-1' && adjacent) {
            const r = s.melee(e.id, adjacent.id);
            if (!('error' in r) && r.hit && adjacent.size <= 1)
              s.applyCondition(adjacent.id, { id: 'prone', source: e.id });
            return;
          }
          if (e.conditions.some((c) => c.id === 'grappled')) {
            s.tryMove(e.id, { x: e.pos.x, y: e.pos.y - 1 });
            s.escape(e.id);
            if (s.get(e.id).conditions.some((c) => c.id === 'grappled')) {
              const a = nearest(s, s.get(e.id)).find(
                (f) => distance(e, f, s.map.diagonalRule) <= 5,
              );
              if (a) s.melee(e.id, a.id);
              return;
            }
          }
          if (e.conditions.some((c) => c.id === 'prone')) {
            // crawl first (doubled cost), then decide whether standing is worth half the speed
            s.tryMove(e.id, { x: e.pos.x, y: e.pos.y - 1 });
            s.standUp(e.id);
          }
          if (e.range && !adjacent) return kiteTurn(s, s.get(e.id));
          policy(s, s.get(e.id));
        },
        { maxRounds: 12 },
      );
    },
  },
  {
    name: 'forest-4v6-v1',
    purpose:
      'Four PCs (fighter, archer, wizard, cleric) against six goblins on the forest clearing with the pond and trees; all foes run the monster policy.',
    seed: 3108,
    run(seed) {
      const sim = new Sim('forest-4v6-v1', seed, forest(), [
        fighter('pc-garrick', { x: 13, y: 10 }),
        archer('pc-wren', { x: 15, y: 11 }),
        wizard('pc-merel', { x: 11, y: 11 }, 3, { '1': 4, '2': 2 }),
        cleric('pc-ines', { x: 17, y: 10 }),
        monster('monster:goblin-warrior', 'goblin-1', { x: 12, y: 3 }),
        monster('monster:goblin-warrior', 'goblin-2', { x: 14, y: 3 }),
        monster('monster:goblin-warrior', 'goblin-3', { x: 16, y: 3 }),
        monster('monster:goblin-warrior', 'goblin-4', { x: 13, y: 2 }),
        monster('monster:goblin-minion', 'goblin-5', { x: 15, y: 2 }),
        monster('monster:goblin-minion', 'goblin-6', { x: 17, y: 3 }),
      ]);
      return sim.run(
        (s, e) => {
          if (e.team === 'foe') return policy(s, e);
          if (e.range) return kiteTurn(s, e);
          if (e.caster?.classId === 'class:wizard') {
            for (const f of nearest(s, e))
              if (
                !('error' in s.cast(e.id, 'spell:fire-bolt', 0, { id: f.id }))
              )
                return;
          }
          if (e.caster?.classId === 'class:cleric') {
            for (const f of nearest(s, e))
              if (
                !(
                  'error' in s.cast(e.id, 'spell:sacred-flame', 0, { id: f.id })
                )
              )
                return;
          }
          s.policyTurn(s.get(e.id));
        },
        { maxRounds: 14 },
      );
    },
  },
];
