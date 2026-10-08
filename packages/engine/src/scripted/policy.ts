import type { GridPos } from '@game/schema';
import { attack } from '../combat/attack.js';
import { path } from '../map/path.js';
import { distance, type Placed } from '../map/geometry.js';
import type { MovementState } from '../map/reachable.js';

type Combatant = Placed & {
  id: string;
  team: string;
  hp: number;
  ac: number;
  speed: number;
  attackBonus: number;
  damage: string;
};
export type MonsterDecision =
  | { kind: 'attack'; targetId: string }
  | { kind: 'approach'; path: GridPos[] }
  | { kind: 'flee'; path: GridPos[] }
  | { kind: 'hold' };

/** A deterministic, no-LLM monster policy: attack in reach, A* approach, otherwise flee at low HP. */
export function monsterPolicy(input: {
  map: MovementState['map'];
  entities: readonly Combatant[];
  monsterId: string;
  fleeing?: boolean;
}): MonsterDecision {
  const monster = input.entities.find((e) => e.id === input.monsterId);
  if (!monster) return { kind: 'hold' };
  const opponents = input.entities.filter(
    (e) => e.team !== monster.team && e.hp > 0,
  );
  if (!opponents.length) return { kind: 'hold' };
  const target = [...opponents].sort(
    (a, b) =>
      distance(monster, a, input.map.diagonalRule) -
        distance(monster, b, input.map.diagonalRule) ||
      a.id.localeCompare(b.id),
  )[0]!;
  if (input.fleeing) {
    const candidates = opponents.flatMap((enemy) => {
      const state: MovementState = { map: input.map, entities: input.entities };
      const away = {
        x: monster.pos.x + Math.sign(monster.pos.x - enemy.pos.x),
        y: monster.pos.y + Math.sign(monster.pos.y - enemy.pos.y),
      };
      const result = path(state, monster.id, away);
      return 'path' in result ? [result.path] : [];
    });
    return candidates[0]
      ? { kind: 'flee', path: candidates[0] }
      : { kind: 'hold' };
  }
  if (distance(monster, target, input.map.diagonalRule) <= 5)
    return { kind: 'attack', targetId: target.id };
  const state: MovementState = { map: input.map, entities: input.entities };
  const goals = Array.from({ length: 8 }, (_, index) => {
    const dx = [-1, 0, 1, -1, 1, -1, 0, 1][index]!;
    const dy = [-1, -1, -1, 0, 0, 1, 1, 1][index]!;
    return { x: target.pos.x + dx, y: target.pos.y + dy };
  });
  const routes = goals
    .flatMap((goal) => {
      const result = path(state, monster.id, goal);
      return 'path' in result ? [{ path: result.path, cost: result.cost }] : [];
    })
    .sort((a, b) => a.cost - b.cost || a.path.length - b.path.length);
  return routes[0]
    ? { kind: 'approach', path: routes[0].path }
    : { kind: 'hold' };
}

/** Resolves an attack decision using the shared rules engine attack resolver. */
export function resolveMonsterAttack(
  monster: Combatant,
  target: Combatant,
  seed: number,
) {
  return attack({
    attackerId: monster.id,
    targetId: target.id,
    attackId: 'scimitar',
    seed,
    attackBonus: monster.attackBonus,
    damage: monster.damage,
    damageType: 'slashing',
    targetAc: target.ac,
    target: { hp: target.hp, kind: target.team === 'pc' ? 'pc' : 'monster' },
  });
}
