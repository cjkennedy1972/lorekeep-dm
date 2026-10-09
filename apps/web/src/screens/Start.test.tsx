// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { axe } from 'jest-axe';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { expect, test } from 'vitest';
import { Start } from './Start';
import { http } from '../api';
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
