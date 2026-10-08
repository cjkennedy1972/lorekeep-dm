import { describe, expect, it } from 'vitest';
import type { CombatState } from '@game/schema';
import { createTokenDrawCommands } from '../src/features/map/tokens.js';

const combat: CombatState = {
  round: 1,
  turnIndex: 0,
  initiative: [
    { entityId: 'hero', total: 18 },
    { entityId: 'ogre', total: 9 },
  ],
  resources: {},
  entities: [
    { id: 'hero', kind: 'character', pos: { x: 1, y: 2 }, size: 1, hp: 12 },
    { id: 'ogre', kind: 'monster', pos: { x: 4, y: 2 }, size: 2, hp: 15 },
    { id: 'goblin', kind: 'monster', pos: { x: 8, y: 2 }, size: 1, hp: 8 },
  ],
};

describe('map token draw commands', () => {
  it('draws one token per combatant with distinct non-color team markers', () => {
    const commands = createTokenDrawCommands(combat);
    expect(commands).toHaveLength(combat.entities.length);
    expect(
      new Set(
        commands.map(
          ({ teamMarker }) => `${teamMarker.shape}:${teamMarker.letter}`,
        ),
      ).size,
    ).toBe(2);
    expect(commands.map(({ team }) => team)).toEqual([
      'party',
      'monster',
      'monster',
    ]);
  });

  it('shows bloodied enemies at half HP and never their exact numbers', () => {
    const [hero, ogre, goblin] = createTokenDrawCommands(combat, {
      ogre: { maxHp: 30 },
      goblin: { maxHp: 20 },
    });
    expect(hero?.hpLabel).toBe('HP 12/12');
    expect(ogre?.hpLabel).toBe('bloodied');
    expect(goblin?.hpLabel).toBe('bloodied');
    expect(ogre?.hpLabel).not.toContain('15');
  });

  it('highlights the first initiative entry, uses the entity footprint, and labels conditions', () => {
    const [hero, ogre] = createTokenDrawCommands(combat, {
      hero: { conditions: ['Poisoned', 'Prone'] },
    });
    expect(hero?.active).toBe(true);
    expect(ogre?.active).toBe(false);
    expect(ogre?.footprint).toBe(2);
    expect(hero?.conditions).toEqual([
      { icon: '☠', label: 'Poisoned' },
      { icon: '⌄', label: 'Prone' },
    ]);
  });
});
