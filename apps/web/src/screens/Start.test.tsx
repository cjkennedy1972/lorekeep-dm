// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, test, vi } from 'vitest';
import { Start } from './Start';
import { http } from '../api';
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
