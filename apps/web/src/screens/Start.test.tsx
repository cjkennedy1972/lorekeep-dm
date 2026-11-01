// @vitest-environment jsdom
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, test, vi } from 'vitest';
import { validateCharacter } from '@game/rules-engine';
import { Start } from './Start';
import { http } from '../api';
import { loadCharacterCatalog } from '../features/character/catalog';
import { buildQuickCharacter } from '../features/character/QuickBuild';
import { gameStore } from '../state/store';
import {
  renderApp,
  seedAccount,
  useJar,
  useMockServer,
} from '../../test/helpers';

useMockServer();

const startAt = () =>
  render(
    <MemoryRouter initialEntries={['/start']}>
      <Routes>
        <Route path="/start" element={<Start />} />
        <Route path="/rooms/:id/game" element={<p>Game ready</p>} />
      </Routes>
    </MemoryRouter>,
  );

test('solo start offers adventure, difficulty, levels and accessible character modes', async () => {
  useJar();
  await seedAccount('start@example.com', 'Starter');
  startAt();
  expect(screen.getByText('The Hollow Under Marrowfell')).toBeInTheDocument();
  expect(screen.getByLabelText('Difficulty')).toHaveValue('moderate');
  expect(screen.getByLabelText('Starting level')).toHaveValue('1');
  expect((await axe(document.body)).violations).toEqual([]);
});

test('My games lists resume link with recap and retries failed loads', async () => {
  const jar = useJar();
  await seedAccount('games@example.com', 'Player');
  await jar(`${http.base}/api/tables`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Memory',
      adventureId: 'adventure:01-hollow-under-marrowfell',
      difficulty: 'moderate',
      startingLevel: 1,
    }),
  });
  renderApp('/rooms');
  expect(
    await screen.findByRole('link', { name: 'Resume Memory' }),
  ).toHaveAttribute('href', expect.stringMatching(/\/rooms\/.+\/game/));
});

const classId = (name: string) => {
  const entry = loadCharacterCatalog().entries.find(
    (item) => item.kind === 'class' && item.name === name,
  );
  if (!entry) throw new Error(`no class ${name}`);
  return entry.id;
};

test('solo start creates the class picked in quick build, even without building first', async () => {
  const wizard = classId('Wizard');
  const fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 201,
    json: async () => ({ game: { id: 'new-game' } }),
  });
  vi.spyOn(http, 'fetch').mockImplementation(fetch);
  gameStore.setCharacter(null);
  startAt();
  await userEvent.type(screen.getByLabelText('Game name'), 'Wizard run');
  await userEvent.selectOptions(
    screen.getByLabelText('Class (optional)'),
    wizard,
  );
  await userEvent.click(
    screen.getByRole('button', { name: 'Create solo game' }),
  );
  await screen.findByText('Game ready');
  const body = JSON.parse(fetch.mock.calls[0]![1]!.body as string);
  expect(body.character.classId).toBe(wizard);
});

test('solo start does not reuse a hero built as another class when a different class is picked', async () => {
  const fighter = classId('Fighter');
  const wizard = classId('Wizard');
  buildQuickCharacter(fighter, 1);
  const fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 201,
    json: async () => ({ game: { id: 'new-game' } }),
  });
  vi.spyOn(http, 'fetch').mockImplementation(fetch);
  startAt();
  await userEvent.type(screen.getByLabelText('Game name'), 'Switch');
  await userEvent.selectOptions(
    screen.getByLabelText('Class (optional)'),
    wizard,
  );
  await userEvent.click(
    screen.getByRole('button', { name: 'Create solo game' }),
  );
  await screen.findByText('Game ready');
  const body = JSON.parse(fetch.mock.calls[0]![1]!.body as string);
  expect(body.character.classId).toBe(wizard);
});

afterEach(() => vi.restoreAllMocks());

test('an empty game name is refused in place, before any request is sent', async () => {
  const fetch = vi.fn();
  vi.spyOn(http, 'fetch').mockImplementation(fetch);
  gameStore.setCharacter(null);
  startAt();
  await userEvent.click(
    screen.getByRole('button', { name: 'Create solo game' }),
  );
  const field = screen.getByLabelText('Game name');
  expect(field).toHaveAttribute('aria-invalid', 'true');
  expect(field).toHaveAccessibleDescription('Enter a name for your game.');
  expect(field).toHaveFocus();
  expect(fetch).not.toHaveBeenCalled();
});

test('the empty-name error clears as soon as the name is typed', async () => {
  gameStore.setCharacter(null);
  startAt();
  await userEvent.click(
    screen.getByRole('button', { name: 'Create solo game' }),
  );
  await userEvent.type(screen.getByLabelText('Game name'), 'T');
  expect(screen.getByLabelText('Game name')).not.toHaveAttribute(
    'aria-invalid',
  );
  expect(
    screen.queryByText('Enter a name for your game.'),
  ).not.toBeInTheDocument();
});

test('quick build only builds the character; it does not create a game', async () => {
  const fetch = vi.fn();
  vi.spyOn(http, 'fetch').mockImplementation(fetch);
  gameStore.setCharacter(null);
  startAt();
  await userEvent.click(
    screen.getByRole('button', { name: 'Build character' }),
  );
  expect(
    await screen.findByRole('heading', { name: 'Your hero is built' }),
  ).toBeInTheDocument();
  expect(fetch).not.toHaveBeenCalled();
  expect(gameStore.getState().character).not.toBeNull();
});

test('start reports server field-level errors and keeps the built character on retry', async () => {
  const fetch = vi.fn().mockResolvedValue({
    ok: false,
    status: 400,
    json: async () => ({
      code: 'INVALID_INPUT',
      message: 'Generic invalid input',
      details: [{ path: 'character.id', code: 'invalid_uuid' }],
    }),
  });
  vi.spyOn(http, 'fetch').mockImplementation(fetch);
  gameStore.setCharacter(null);
  startAt();
  await userEvent.type(screen.getByLabelText('Game name'), 'Test game');
  await userEvent.click(
    screen.getByRole('button', { name: 'Create solo game' }),
  );
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Character: id: invalid uuid',
  );
  expect(fetch).toHaveBeenCalledTimes(1);
  await userEvent.click(
    screen.getByRole('button', { name: 'Create solo game' }),
  );
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  const retryBody = JSON.parse(fetch.mock.calls[1]![1]!.body as string);
  expect(retryBody.character).toMatchObject({
    id: expect.stringMatching(/^[0-9a-f-]{36}$/i),
    classId: expect.stringMatching(/^class:/),
    level: 1,
    equipment: expect.arrayContaining([
      expect.objectContaining({ itemId: expect.stringMatching(/^equipment:/) }),
    ]),
  });
  expect(screen.getByRole('alert')).toHaveTextContent(
    'Character: id: invalid uuid',
  );
});

test('changing the starting level after a build clears the hero and sends a character that matches the new level', async () => {
  const fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 201,
    json: async () => ({ game: { id: 'level-game' } }),
  });
  vi.spyOn(http, 'fetch').mockImplementation(fetch);
  gameStore.setCharacter(null);
  startAt();
  await userEvent.click(
    screen.getByRole('button', { name: 'Build character' }),
  );
  await screen.findByRole('heading', { name: 'Your hero is built' });
  await userEvent.selectOptions(screen.getByLabelText('Starting level'), '3');
  expect(
    screen.queryByRole('heading', { name: 'Your hero is built' }),
  ).toBeNull();
  expect(
    screen.getByText(/Changing the starting level cleared your built hero/),
  ).toBeInTheDocument();
  await userEvent.type(screen.getByLabelText('Game name'), 'Level change');
  await userEvent.click(
    screen.getByRole('button', { name: 'Create solo game' }),
  );
  await screen.findByText('Game ready');
  expect(fetch).toHaveBeenCalledTimes(1);
  const body = JSON.parse(fetch.mock.calls[0]![1]!.body as string);
  expect(body.character.level).toBe(3);
  expect(validateCharacter(body.character, loadCharacterCatalog())).toEqual([]);
});

async function buildFighterInWizard(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('radio', { name: /Guided wizard/ }));
  await user.click(screen.getByRole('radio', { name: /Fighter/ }));
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  await user.click(screen.getByRole('radio', { name: /Soldier/ }));
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  await user.click(screen.getByRole('radio', { name: /Human/ }));
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  await user.click(screen.getByRole('radio', { name: /Standard array/ }));
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  const choices = screen.getAllByRole('checkbox');
  await user.click(choices[0]!);
  await user.click(choices[1]!);
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  await user.click(
    within(
      screen.getByRole('group', { name: 'Choose starting equipment' }),
    ).getAllByRole('radio')[0]!,
  );
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  await user.type(screen.getByLabelText('Character name'), 'Talia');
}

test('the guided wizard refuses a starting level above 1 and sends no create request', async () => {
  const fetch = vi.fn();
  vi.spyOn(http, 'fetch').mockImplementation(fetch);
  gameStore.setCharacter(null);
  const user = userEvent.setup();
  startAt();
  await user.type(screen.getByLabelText('Game name'), 'Wizard level');
  await user.selectOptions(screen.getByLabelText('Starting level'), '3');
  await buildFighterInWizard(user);
  expect(
    screen.getByRole('list', { name: 'Character validation issues' }),
  ).toHaveTextContent('The guided wizard creates level-one heroes');
  await user.click(screen.getByRole('button', { name: 'Save character' }));
  expect(fetch).not.toHaveBeenCalled();
  expect(gameStore.getState().character).toBeNull();
});

test('the guided wizard at starting level 1 sends a create request that validates', async () => {
  const fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 201,
    json: async () => ({ game: { id: 'wizard-game' } }),
  });
  vi.spyOn(http, 'fetch').mockImplementation(fetch);
  gameStore.setCharacter(null);
  const user = userEvent.setup();
  startAt();
  await user.type(screen.getByLabelText('Game name'), 'Wizard level one');
  await buildFighterInWizard(user);
  await user.click(screen.getByRole('button', { name: 'Save character' }));
  await screen.findByText('Game ready');
  const body = JSON.parse(fetch.mock.calls[0]![1]!.body as string);
  expect(body.character.level).toBe(1);
  expect(validateCharacter(body.character, loadCharacterCatalog())).toEqual([]);
});

test('solo start auto-builds a character when none has been made', async () => {
  gameStore.setCharacter(null);
  const fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 201,
    json: async () => ({ game: { id: 'new-game' } }),
  });
  vi.spyOn(http, 'fetch').mockImplementation(fetch);
  startAt();
  await userEvent.type(screen.getByLabelText('Game name'), 'Quick start');
  await userEvent.selectOptions(screen.getByLabelText('Starting level'), '2');
  await userEvent.click(
    screen.getByRole('button', { name: 'Create solo game' }),
  );
  await screen.findByText('Game ready');
  expect(fetch).toHaveBeenCalledTimes(1);
  const body = JSON.parse(fetch.mock.calls[0]![1]!.body as string);
  expect(body.character).toMatchObject({
    id: expect.stringMatching(/^[0-9a-f-]{36}$/i),
    classId: expect.stringMatching(/^class:/),
    level: 2,
    equipment: expect.arrayContaining([
      expect.objectContaining({ itemId: expect.stringMatching(/^equipment:/) }),
    ]),
  });
});
