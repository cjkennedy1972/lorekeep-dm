// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react';
import { expect, test } from 'vitest';
import type { Character } from '@game/schema';
import { Sheet } from './Sheet.js';

const abilities = { str: 15, dex: 12, con: 14, int: 8, wis: 10, cha: 9 };

const character = {
  id: 'char-1',
  name: 'Mara',
  classId: 'class:fighter',
  level: 1,
  abilities,
  hp: { current: 11, max: 11, temp: 0 },
  conditions: [],
  slots: {},
  skills: [],
  equipment: [
    { itemId: 'equipment:dungeoneer-s-pack', qty: 1, equipped: false },
    { itemId: 'equipment:chain-mail', qty: 1, equipped: true },
  ],
} as unknown as Character;

test('inventory shows catalog item names with their apostrophes', () => {
  render(<Sheet character={character} />);

  const inventory = within(
    screen.getByRole('region', { name: 'Inventory' }),
  ).getByRole('list');
  expect(inventory.textContent).toContain('Dungeoneer’s Pack');
  expect(inventory.textContent).not.toMatch(/Dungeoneer S Pack/);
});
