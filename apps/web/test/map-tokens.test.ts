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

  it('labels an entity with no presentation name from its catalog id, never the raw id', () => {
    const uuid = '3f2a9c1e-7b4d-4e8a-9f10-2c5d6e7f8a9b';
    const commands = createTokenDrawCommands({
      ...combat,
      entities: [
        ...combat.entities,
        {
          id: `ent_${uuid}`,
          kind: 'monster',
          pos: { x: 5, y: 2 },
          size: 1,
          hp: 4,
        },
      ],
    });
    const [, , goblin, unnamed] = commands;
    expect(goblin?.name).toBe('Goblin');
    expect(unnamed?.name).toBe('Combatant');
    expect(unnamed?.name).not.toContain(uuid.slice(0, 8));
  });

  it('shows bloodied enemies at half HP and never their exact numbers', () => {
    const [hero, ogre, goblin] = createTokenDrawCommands(combat, {
      hero: { maxHp: 12 },
      ogre: { maxHp: 30 },
      goblin: { maxHp: 20 },
    });
    expect(hero?.hpLabel).toBe('HP 12/12 (healthy)');
    expect(ogre?.hpLabel).toBe('bloodied');
    expect(goblin?.hpLabel).toBe('bloodied');
    expect(ogre?.hpLabel).not.toContain('15');
  });

  it('never invents a max HP: a PC with an unknown max shows current HP only', () => {
    // The old fallback used the current HP as the max, so a 4-HP hero read "HP 4/4".
    const [hero] = createTokenDrawCommands({
      ...combat,
      entities: [{ ...combat.entities[0]!, hp: 4 }],
      initiative: [{ entityId: 'hero', total: 18 }],
    });
    expect(hero?.hpLabel).toBe('HP 4');
  });

  it('derives the status word from the server hpState when no max is known', () => {
    const [hero, ogre, goblin] = createTokenDrawCommands(combat, {
      hero: { hpState: 'wounded' },
      ogre: { hpState: 'wounded' },
      goblin: { hpState: 'down' },
    });
    expect(hero?.hpLabel).toBe('HP 12 (bloodied)');
    expect(ogre?.hpLabel).toBe('bloodied');
    expect(goblin?.hpLabel).toBe('down');
  });

  it('never prints a monster’s numeric HP, even with no known max or status word', () => {
    const [, ogre] = createTokenDrawCommands(combat, {
      ogre: { hpState: 'wounded' },
    });
    const [, bare] = createTokenDrawCommands(combat);
    expect(ogre?.hpLabel).toBe('bloodied');
    expect(bare?.hpLabel).not.toMatch(/\d/);
  });

  it('reads a monster at 0 HP as down even when the status says healthy', () => {
    const [, , goblin] = createTokenDrawCommands(
      {
        ...combat,
        entities: combat.entities.map((e) =>
          e.id === 'goblin' ? { ...e, hp: 0 } : e,
        ),
      },
      { goblin: { maxHp: 20, hpState: 'healthy' } },
    );
    expect(goblin?.hpLabel).toBe('down');
  });

  it('highlights the active entity, uses the entity footprint, and labels conditions', () => {
    const [hero, ogre] = createTokenDrawCommands(
      { ...combat, activeEntityId: 'hero' },
      {
        hero: { conditions: ['Poisoned', 'Prone'] },
      },
    );
    expect(hero?.active).toBe(true);
    expect(ogre?.active).toBe(false);
    expect(ogre?.footprint).toBe(2);
    expect(hero?.conditions).toEqual([
      { icon: '☠', label: 'Poisoned' },
      { icon: '⌄', label: 'Prone' },
    ]);
  });

  it('marks no token active when activeEntityId is null, even with a populated initiative', () => {
    const commands = createTokenDrawCommands({
      ...combat,
      activeEntityId: null,
    });
    expect(commands.filter((c) => c.active)).toHaveLength(0);
  });
});
