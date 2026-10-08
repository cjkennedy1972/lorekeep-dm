import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { loadAuthoredMap } from '../src/map/load.js';
import { monsterPolicy } from '../src/scripted/policy.js';

const json = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../maps/crypt-room.json', import.meta.url)),
    'utf8',
  ),
) as unknown;
const loaded = loadAuthoredMap(json);
if (!loaded.ok) throw new Error('crypt map invalid');
const map = loaded.map;
const who = (id: string, team: string, x: number, y: number, hp = 10) => ({
  id,
  team,
  pos: { x, y },
  size: 1,
  hp,
  ac: 12,
  speed: 30,
  attackBonus: 4,
  damage: '1d6',
});

// M2-06 regression: the policy built its path state with no movement budget, so every route was
// "unreachable" and a surviving monster that was not already in reach always returned `hold`.
describe('monsterPolicy turns for a monster that is not yet in reach', () => {
  test('approaches a target within one move, ending adjacent', () => {
    const d = monsterPolicy({
      map,
      monsterId: 'g',
      entities: [who('g', 'foe', 2, 2), who('p', 'pc', 6, 2)],
    });
    expect(d.kind).toBe('approach');
    if (d.kind === 'approach') {
      expect(d.path[0]).toEqual({ x: 2, y: 2 });
      const end = d.path[d.path.length - 1]!;
      expect(Math.max(Math.abs(end.x - 6), Math.abs(end.y - 2))).toBe(1);
    }
  });

  test('a target farther than one move away still yields an approach, cut to the monster speed', () => {
    const d = monsterPolicy({
      map,
      monsterId: 'g',
      entities: [who('g', 'foe', 2, 2), who('p', 'pc', 17, 17)],
    });
    expect(d.kind).toBe('approach');
    if (d.kind === 'approach') expect(d.path.length - 1).toBeLessThanOrEqual(6); // 30 ft speed, 5 ft cells
  });

  test('flees one step away when fleeing', () => {
    const d = monsterPolicy({
      map,
      monsterId: 'g',
      fleeing: true,
      entities: [who('g', 'foe', 5, 5), who('p', 'pc', 4, 5)],
    });
    expect(d.kind).toBe('flee');
  });

  test('attacks when already in reach and holds with no living opponent', () => {
    expect(
      monsterPolicy({
        map,
        monsterId: 'g',
        entities: [who('g', 'foe', 5, 5), who('p', 'pc', 6, 5)],
      }).kind,
    ).toBe('attack');
    expect(
      monsterPolicy({
        map,
        monsterId: 'g',
        entities: [who('g', 'foe', 5, 5), who('p', 'pc', 6, 5, 0)],
      }).kind,
    ).toBe('hold');
  });
});
