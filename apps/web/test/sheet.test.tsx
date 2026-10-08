import { act, render, screen } from '@testing-library/react';
import { axe } from 'jest-axe';
import { describe, expect, it } from 'vitest';
import type { Character } from '@game/schema';
import { createGameStore } from '../src/state/gameStore';
import { Sheet } from '../src/features/character/Sheet';

const makeCharacter = (classId = 'class:fighter'): Character => ({
  id: '00000000-0000-4000-8000-000000000001',
  name: 'Mira', speciesId: 'species:human', classId, backgroundId: 'background:guard', level: 1,
  abilities: { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 },
  proficiencies: { skills: ['athletics'], saves: ['str', 'con'], tools: [] },
  equipment: [{ itemId: 'equipment:longsword', qty: 1, equipped: true }],
  spellsKnown: [], spellsPrepared: [], slots: { '1': { max: 2, used: 0 } },
  hp: { current: 12, max: 12, temp: 0 }, conditions: [],
});

describe('live character sheet', () => {
  it('reflects HP, conditions and spell slots in the same act flush and announces HP changes', () => {
    const store = createGameStore();
    store.setCharacter(makeCharacter());
    render(<Sheet store={store} />);
    act(() => {
      store.applyEvent({ type: 'HpChanged', entityId: makeCharacter().id, delta: -4, hp: 8 });
      store.applyEvent({ type: 'ConditionApplied', entityId: makeCharacter().id, conditionId: 'condition:poisoned' });
      store.applyEvent({ type: 'SlotSpent', entityId: makeCharacter().id, level: 1 });
    });
    expect(screen.getByText('8 / 12')).toBeInTheDocument();
    expect(screen.getByText('poisoned')).toBeInTheDocument();
    expect(screen.getByText('Level 1: 1 of 2 remaining')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Hit points changed to 8 of 12');
  });

  it('renders for all twelve class fixtures', () => {
    const classes = ['barbarian', 'bard', 'cleric', 'druid', 'fighter', 'monk', 'paladin', 'ranger', 'rogue', 'sorcerer', 'warlock', 'wizard'];
    for (const classId of classes) {
      const { unmount } = render(<Sheet character={makeCharacter(`class:${classId}`)} />);
      expect(screen.getByRole('heading', { level: 1, name: 'Mira' })).toBeInTheDocument();
      expect(screen.getByText(new RegExp(classId, 'i'))).toBeInTheDocument();
      unmount();
    }
  });

  it('has no axe violations', async () => {
    const { container } = render(<Sheet character={makeCharacter()} />);
    expect((await axe(container)).violations).toEqual([]);
  });
});
