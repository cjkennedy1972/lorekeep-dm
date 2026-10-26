// @vitest-environment jsdom
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { expect, test, vi } from 'vitest';
import { App } from '../App';
import { http } from '../api';
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

test('My games links to resume and offers the solo start flow', async () => {
  useJar();
  await seedAccount('h2@example.com', 'Harper');
  renderApp('/rooms');
  expect(await screen.findByText(/no games yet/i)).toBeInTheDocument();
  expect((await axe(document.body)).violations).toEqual([]);
  expect(
    screen.getByRole('link', { name: 'Start a solo game' }),
  ).toHaveAttribute('href', '/start');
  expect(
    screen.getByRole('link', { name: 'Build a character' }),
  ).toBeInTheDocument();
});

test('host reloading the lobby gets no stale/blank link and can create a new one', async () => {
  const host = useJar();
  await seedAccount('h4@example.com', 'Reloader');
  const created = await (
    await host(`${http.base}/api/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Reload Hall' }),
    })
  ).json();
  // A reload no longer receives the one-time invite code from the mock API.
  const roomId = created.room.id as string;
  const rooms = await host(`${http.base}/api/rooms`);
  const roomList = (await rooms.json()) as {
    rooms: { id: string; code?: string }[];
  };
  expect(
    roomList.rooms.find((item) => item.id === roomId)?.code,
  ).toBeUndefined();
  renderApp(`/rooms/${roomId}`);
  expect(await screen.findByText(/cannot be shown again/i)).toBeInTheDocument();
  expect(screen.queryByLabelText('Invite link')).toBeNull();
  await userEvent.click(
    screen.getByRole('button', { name: 'Create new invite link' }),
  );
  const input = (await screen.findByLabelText(
    'Invite link',
  )) as HTMLInputElement;
  expect(input.value).toMatch(/\/join\/[A-Za-z0-9_-]{22}$/);
  expect(input.value).not.toContain(created.room.code);
  // The lobby has replaced its former invite URL with the newly minted code.
  expect(input.value.split('/join/')[1]).not.toBe(created.room.code);
  expect(input.value).toMatch(/\/join\/[A-Za-z0-9_-]{22}$/);
});

test('host can choose a lower table tier, which is visible to all players', async () => {
  const host = useJar();
  await seedAccount('tier-host@example.com', 'Tier Host');
  const created = await (
    await host(`${http.base}/api/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Tier Hall' }),
    })
  ).json();
  const roomId = created.room.id as string;
  renderApp(`/rooms/${roomId}`);
  const selector = await screen.findByRole('combobox', {
    name: 'Table content tier',
  });
  expect(selector).toHaveValue('mature');
  // The opt-out field renders only after /api/me resolves, so await it.
  expect(
    within(
      await screen.findByRole('group', { name: 'Mature content' }),
    ).getByText(/Mature is on by default/),
  ).toBeInTheDocument();
  expect(
    screen.getByText(/You can opt out of Mature content below/),
  ).toBeInTheDocument();
  await userEvent.selectOptions(selector, 'standard');
  await waitFor(() =>
    expect(screen.getByText('Table setting saved.')).toBeInTheDocument(),
  );
  await waitFor(() =>
    expect(
      screen.getByText('Standard', { selector: 'strong' }),
    ).toBeInTheDocument(),
  );
  expect(screen.queryByText(/Mature is on by default/)).not.toBeInTheDocument();
  expect(
    within(screen.getByRole('group', { name: 'Mature content' })).getByText(
      /Mature-tier content is unavailable under this cap/,
    ),
  ).toBeInTheDocument();
  expect(
    within(screen.getByRole('group', { name: 'Mature content' })).getByText(
      /personal Mature opt-out preference is saved separately/,
    ),
  ).toBeInTheDocument();
  const details = await (await host(`${http.base}/api/rooms/${roomId}`)).json();
  expect(details.room.tierCap).toBe('standard');

  const playerJar = useJar();
  await seedAccount('tier-player@example.com', 'Tier Player');
  const joined = await playerJar(
    `${http.base}/api/invites/${created.room.code}/join`,
    { method: 'POST' },
  );
  expect(joined.status).toBe(200);
  const playerRoom = await playerJar(`${http.base}/api/rooms/${roomId}`);
  expect((await playerRoom.json()).room.tierCap).toBe('standard');
});

test('host lobby restores the saved content tier after loading room details', async () => {
  const host = useJar();
  await seedAccount('tier-reload@example.com', 'Tier Reloader');
  const created = await (
    await host(`${http.base}/api/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Saved Tier Hall' }),
    })
  ).json();
  const roomId = created.room.id as string;
  await host(`${http.base}/api/sessions/${roomId}/content-tier`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tier: 'family' }),
  });

  renderApp(`/rooms/${roomId}`);
  const selector = await screen.findByRole('combobox', {
    name: 'Table content tier',
  });
  await waitFor(() => expect(selector).toHaveValue('family'));
  expect(
    screen.getByText('Family', { selector: 'strong' }),
  ).toBeInTheDocument();
  expect(screen.queryByText(/Mature is on by default/)).not.toBeInTheDocument();
  expect(
    within(
      await screen.findByRole('group', { name: 'Mature content' }),
    ).getByText(/Mature-tier content is unavailable under this cap/),
  ).toBeInTheDocument();
});

test('invalid invite shows a clear error', async () => {
  useJar();
  await seedAccount('x@example.com', 'X');
  renderApp('/join/NOPE00');
  expect(await screen.findByRole('alert')).toHaveTextContent(
    /no longer valid/i,
  );
});

test('join shows the mature opt-out before joining; keyboard toggle is saved with the join', async () => {
  const host = useJar();
  await seedAccount('h5@example.com', 'Hostess');
  const created = await (
    await host(`${http.base}/api/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Opt Out Hall' }),
    })
  ).json();
  useJar();
  await seedAccount('p5@example.com', 'Player');
  renderApp(`/join/${created.room.code}`);
  const box = await screen.findByRole('checkbox', {
    name: 'Opt out of mature content',
  });
  expect(box).not.toBeChecked();
  expect(
    screen.queryByRole('heading', { name: 'Opt Out Hall' }),
  ).not.toBeInTheDocument();
  box.focus();
  await userEvent.keyboard(' ');
  expect(box).toBeChecked();
  await userEvent.click(screen.getByRole('button', { name: 'Join table' }));
  expect(
    await screen.findByRole('heading', { name: 'Opt Out Hall' }),
  ).toBeInTheDocument();
  const me = (await (await http.fetch(`${http.base}/api/me`)).json()) as {
    account: { matureOptOut: boolean };
  };
  expect(me.account.matureOptOut).toBe(true);
});

test('failed join does not save a changed mature opt-out preference', async () => {
  const host = useJar();
  await seedAccount('full-host@example.com', 'Full Host');
  const created = await (
    await host(`${http.base}/api/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Full Hall' }),
    })
  ).json();

  for (let i = 0; i < 5; i += 1) {
    const player = useJar();
    await seedAccount(`full-player-${i}@example.com`, `Player ${i}`);
    const joined = await player(
      `${http.base}/api/invites/${created.room.code}/join`,
      { method: 'POST' },
    );
    expect(joined.status).toBe(200);
  }

  const joiningPlayer = useJar();
  await seedAccount('full-player-final@example.com', 'Final Player');
  renderApp(`/join/${created.room.code}`);
  const box = await screen.findByRole('checkbox', {
    name: 'Opt out of mature content',
  });
  expect(box).not.toBeChecked();
  await userEvent.click(box);
  await userEvent.click(screen.getByRole('button', { name: 'Join table' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(/table is full/i);

  const me = (await (await joiningPlayer(`${http.base}/api/me`)).json()) as {
    account: { matureOptOut: boolean };
  };
  expect(me.account.matureOptOut).toBe(false);
});

test('lobby content settings: mature is on by default; opt-out toggles and saves', async () => {
  useJar();
  await seedAccount('h6@example.com', 'Lobbyist');
  const created = await (
    await http.fetch(`${http.base}/api/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Settings Hall' }),
    })
  ).json();
  renderApp(`/rooms/${created.room.id as string}`);
  const box = await screen.findByRole('checkbox', {
    name: 'Opt out of mature content',
  });
  expect(box).not.toBeChecked();
  box.focus();
  await userEvent.keyboard(' ');
  expect(await screen.findByText('Content setting saved.')).toBeInTheDocument();
  expect(box).toBeChecked();
  const me = (await (await http.fetch(`${http.base}/api/me`)).json()) as {
    account: { matureOptOut: boolean };
  };
  expect(me.account.matureOptOut).toBe(true);
  expect((await axe(document.body)).violations).toEqual([]);
});

// ---- M0-24: auth screens ----

const ADULT = '1990-01-01';
const fillSignup = async (birthdate = ADULT, email = 'new@example.com') => {
  await userEvent.type(screen.getByLabelText('Email'), email);
  await userEvent.type(screen.getByLabelText('Display name'), 'Newbie');
  await userEvent.type(
    screen.getByLabelText('Password'),
    'correct-horse-battery',
  );
  await userEvent.type(screen.getByLabelText('Date of birth'), birthdate);
  await userEvent.click(screen.getByLabelText(/accept the Terms/i));
  await userEvent.click(screen.getByLabelText(/18 years or older/i));
};

test.each([
  '/signup',
  '/login',
  '/check-email',
  '/verify?token=valid-token',
  '/forgot',
  '/reset?token=valid-token',
])('jest-axe: zero violations on %s', async (path) => {
  useJar();
  renderApp(path);
  await screen.findByRole('heading', { level: 1 });
  expect((await axe(document.body)).violations).toEqual([]);
});

test('signup: empty submit associates and announces field errors and focuses the first', async () => {
  useJar();
  renderApp('/signup');
  await userEvent.click(screen.getByRole('button', { name: 'Create account' }));
  const email = screen.getByLabelText('Email');
  expect(email).toHaveFocus();
  expect(email).toHaveAttribute('aria-invalid', 'true');
  const err = document.getElementById(email.getAttribute('aria-describedby')!)!;
  expect(err).toHaveTextContent('Enter a valid email address.');
  expect(err).toHaveAttribute('role', 'alert');
  expect(screen.getByLabelText('Date of birth')).toHaveAttribute(
    'aria-describedby',
    expect.stringContaining('birthdate-error'),
  );
  expect(screen.getByLabelText('Email')).toHaveAttribute(
    'autocomplete',
    'email',
  );
  expect(screen.getByLabelText('Password')).toHaveAttribute(
    'autocomplete',
    'new-password',
  );
  expect((await axe(document.body)).violations).toEqual([]);
});

test('signup: adult goes to check-your-email; birthdate is cleared and never stored or logged', async () => {
  useJar();
  const log = vi.spyOn(console, 'log');
  const warn = vi.spyOn(console, 'warn');
  const error = vi.spyOn(console, 'error');
  renderApp('/signup');
  await fillSignup('1985-06-15', 'adult@example.com');
  await userEvent.click(screen.getByRole('button', { name: 'Create account' }));
  expect(
    await screen.findByRole('heading', { name: 'Check your email' }),
  ).toBeInTheDocument();
  for (const store of [localStorage, sessionStorage])
    expect(JSON.stringify({ ...store })).not.toContain('1985-06-15');
  for (const spy of [log, warn, error])
    expect(JSON.stringify(spy.mock.calls)).not.toContain('1985-06-15');
});

test("signup: under-18 shows the server's refusal neutrally with no form to retry", async () => {
  useJar();
  renderApp('/signup');
  const y = new Date().getUTCFullYear() - 10;
  await fillSignup(`${y}-01-01`, 'kid@example.com');
  await userEvent.click(screen.getByRole('button', { name: 'Create account' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'You must be 18 or older to create an account.',
  );
  expect(screen.queryByRole('button', { name: 'Create account' })).toBeNull();
  expect(screen.queryByLabelText('Date of birth')).toBeNull();
});

test('login: unknown email and wrong password show identical text; success returns to the join', async () => {
  useJar();
  await seedAccount('known@example.com', 'Known');
  useJar();
  renderApp('/login');
  const submit = async (email: string, password: string) => {
    await userEvent.clear(screen.getByLabelText('Email'));
    await userEvent.type(screen.getByLabelText('Email'), email);
    await userEvent.type(screen.getByLabelText('Password'), password);
    await userEvent.click(screen.getByRole('button', { name: 'Log in' }));
    return (await screen.findByRole('alert')).textContent;
  };
  const unknown = await submit('nobody@example.com', 'whatever-password');
  const wrong = await submit('known@example.com', 'definitely-wrong-pw');
  expect(unknown).toBe(wrong);
  expect(screen.getByLabelText('Email')).toHaveAttribute(
    'aria-describedby',
    'login-error',
  );
  expect(screen.getByLabelText('Password')).toHaveAttribute(
    'aria-describedby',
    'login-error',
  );
});

test('logged-out join link: login returns to the join and the lobby opens', async () => {
  const host = useJar();
  await seedAccount('h3@example.com', 'Hostess');
  const created = await (
    await host(`${http.base}/api/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Return Trip' }),
    })
  ).json();
  useJar();
  await seedAccount('joiner@example.com', 'Joiner');
  useJar(); // signed out; account exists
  renderApp(`/join/${created.room.code}`);
  expect(
    await screen.findByRole('heading', { name: 'Log in' }),
  ).toBeInTheDocument();
  await userEvent.type(screen.getByLabelText('Email'), 'joiner@example.com');
  await userEvent.type(
    screen.getByLabelText('Password'),
    'correct-horse-battery',
  );
  await userEvent.click(screen.getByRole('button', { name: 'Log in' }));
  await userEvent.click(
    await screen.findByRole('button', { name: 'Join table' }),
  );
  expect(
    await screen.findByRole('heading', { name: 'Return Trip' }),
  ).toBeInTheDocument();
});

test('verify: valid token succeeds, bad token reports failure', async () => {
  useJar();
  const { unmount } = renderApp('/verify?token=valid-token');
  await userEvent.type(
    screen.getByLabelText('Password'),
    'a-brand-new-password',
  );
  await userEvent.click(screen.getByRole('button', { name: 'Verify email' }));
  expect(await screen.findByText(/email is verified/i)).toBeInTheDocument();
  unmount();
  renderApp('/verify?token=stale');
  await userEvent.type(
    screen.getByLabelText('Password'),
    'a-brand-new-password',
  );
  await userEvent.click(screen.getByRole('button', { name: 'Verify email' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    /invalid or has expired/i,
  );
});

test('forgot gives the same answer for any email; reset with a good token returns to login', async () => {
  useJar();
  const { unmount } = renderApp('/forgot');
  await userEvent.type(screen.getByLabelText('Email'), 'anyone@example.com');
  await userEvent.click(
    screen.getByRole('button', { name: 'Send reset link' }),
  );
  expect(await screen.findByRole('status')).toHaveTextContent(
    /If an account exists/,
  );
  unmount();
  renderApp('/reset?token=valid-token');
  await userEvent.type(screen.getByLabelText('New password'), 'short');
  await userEvent.click(
    screen.getByRole('button', { name: 'Set new password' }),
  );
  expect(screen.getByLabelText('New password')).toHaveFocus();
  await userEvent.type(
    screen.getByLabelText('New password'),
    '-and-now-long-enough',
  );
  await userEvent.click(
    screen.getByRole('button', { name: 'Set new password' }),
  );
  expect(
    await screen.findByRole('heading', { name: 'Log in' }),
  ).toBeInTheDocument();
});
