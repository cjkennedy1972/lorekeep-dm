// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { expect, test, vi } from 'vitest';
import { App } from '../App';
import { AuthProvider } from '../auth';
import {
  renderApp,
  seedAccount,
  useJar,
  useMockServer,
} from '../../test/helpers';

useMockServer();

function Probe() {
  const l = useLocation();
  return (
    <output data-testid="probe">{l.pathname + JSON.stringify(l.state)}</output>
  );
}

test('logged-out join link redirects to /login remembering the join as the return target', async () => {
  useJar();
  render(
    <MemoryRouter initialEntries={['/join/ABC123']}>
      <AuthProvider>
        <App />
        <Probe />
      </AuthProvider>
    </MemoryRouter>,
  );
  const probe = await screen.findByTestId('probe');
  await waitFor(() => expect(probe).toHaveTextContent('/login'));
  expect(probe).toHaveTextContent('"from":"/join/ABC123"');
});

test('rooms list, create, lobby shows live seats and announces presence politely, copy gives feedback', async () => {
  useJar();
  await seedAccount('h2@example.com', 'Harper');
  renderApp('/rooms');
  expect(await screen.findByText(/no tables yet/i)).toBeInTheDocument();
  expect((await axe(document.body)).violations).toEqual([]);
  await userEvent.type(screen.getByLabelText('Table name'), 'Dragon Keep');
  await userEvent.click(screen.getByRole('button', { name: 'Create table' }));
  expect(
    await screen.findByRole('heading', { name: 'Dragon Keep' }),
  ).toBeInTheDocument();
  const list = await screen.findByRole('list', { name: /players/i });
  await waitFor(() => expect(list).toHaveTextContent('Harper (online)'));
  expect(list).toHaveTextContent('Scripted Sam (online)');
  expect(document.querySelector('[aria-live="polite"]')).not.toBeNull();
  expect((await axe(document.body)).violations).toEqual([]);

  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
  await userEvent.click(
    screen.getByRole('button', { name: 'Copy invite link' }),
  );
  expect(writeText).toHaveBeenCalledWith(
    expect.stringMatching(/\/join\/[A-Z0-9]{6}$/),
  );
  expect(
    await screen.findByText('Invite link copied to clipboard.'),
  ).toBeInTheDocument();

  const before = (screen.getByLabelText('Invite link') as HTMLInputElement)
    .value;
  await userEvent.click(
    screen.getByRole('button', { name: 'Regenerate link' }),
  );
  await screen.findByText(/old link no longer works/i);
  expect(
    (screen.getByLabelText('Invite link') as HTMLInputElement).value,
  ).not.toBe(before);
});

test('invalid invite shows a clear error', async () => {
  useJar();
  await seedAccount('x@example.com', 'X');
  renderApp('/join/NOPE00');
  expect(await screen.findByRole('alert')).toHaveTextContent(
    /no longer valid/i,
  );
});
