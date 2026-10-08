// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { expect, test } from 'vitest';
import { validateCharacter } from '@game/rules-engine';
import { QuickBuild } from '../src/features/character/QuickBuild';
import { loadCharacterCatalog } from '../src/features/character/catalog';
import { gameStore } from '../src/state/store';

const catalog = loadCharacterCatalog();

test('quick build saves a legal character in at most two clicks for every class', () => {
  for (const characterClass of catalog.entries.filter(
    (entry) => entry.kind === 'class',
  )) {
    gameStore.setCharacter(null);
    const { unmount } = render(
      <MemoryRouter>
        <QuickBuild />
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByLabelText('Class (optional)'), {
      target: { value: characterClass.id },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Build and save character' }),
    );
    expect(gameStore.getState().character).not.toBeNull();
    expect(validateCharacter(gameStore.getState().character!, catalog)).toEqual(
      [],
    );
    expect(
      screen.getByRole('link', { name: 'Edit this character in the wizard' }),
    ).toBeInTheDocument();
    unmount();
  }
});

test('class-optional quick build saves in one click', () => {
  gameStore.setCharacter(null);
  render(
    <MemoryRouter>
      <QuickBuild />
    </MemoryRouter>,
  );
  fireEvent.click(
    screen.getByRole('button', { name: 'Build and save character' }),
  );
  expect(gameStore.getState().character).not.toBeNull();
  expect(validateCharacter(gameStore.getState().character!, catalog)).toEqual(
    [],
  );
});
