// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { expect, test } from 'vitest';
import { axe } from 'jest-axe';
import { Game } from './Game.js';
import { http } from '../api.js';
import { AuthProvider } from '../auth.js';
import { useJar, useMockServer, seedAccount } from '../../test/helpers.js';

useMockServer();

test('live game screen exposes an accessible room wait state', async () => {
  useJar();
  await seedAccount('m236@example.com', 'Mapper');
  render(
    <MemoryRouter initialEntries={['/rooms/test-room/game']}>
      <AuthProvider>
        <Routes>
          <Route path="/rooms/:id/game" element={<Game />} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
  await screen.findByRole('heading', { name: 'Game' });
  expect(
    await screen.findByText('Waiting for room state…'),
  ).toBeInTheDocument();
  expect(
    (await axe(document.body)).violations.filter(
      (violation) => violation.impact === 'critical',
    ),
  ).toEqual([]);
  expect(http.WebSocket).not.toBeNull();
});
