// @vitest-environment jsdom
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { expect, test } from 'vitest';
import { App } from '../App';
import { http } from '../api';
import { AuthProvider } from '../auth';
import { jarFetch, renderApp, useJar, useMockServer } from '../../test/helpers';
import { exportPoll } from './Settings';

useMockServer();
exportPoll.ms = 100;

const PW = 'correct-horse-battery';
async function signup(email: string, name = 'Sage', fetcher = http.fetch) {
  const r = await fetcher(`${http.base}/api/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email,
      password: PW,
      displayName: name,
      birthdate: '1990-01-01',
    }),
  });
  if (!r.ok) throw new Error('seed failed');
}
async function login(email: string) {
  const f = jarFetch();
  await f(`${http.base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PW }),
  });
  return f;
}

test('has no axe violations and lists this device', async () => {
  useJar();
  await signup('s1@example.com');
  renderApp('/settings');
  const list = await screen.findByRole('list', { name: 'Signed-in devices' });
  expect(await within(list).findAllByRole('listitem')).toHaveLength(1);
  expect(list).toHaveTextContent('(this device)');
  expect(list).toHaveTextContent(/Last active/);
  expect((await axe(document.body)).violations).toEqual([]);
});

test('revoking another device updates the list; sign out all other devices', async () => {
  useJar();
  await signup('s2@example.com');
  await login('s2@example.com');
  await login('s2@example.com');
  renderApp('/settings');
  const list = await screen.findByRole('list', { name: 'Signed-in devices' });
  await waitFor(() =>
    expect(within(list).getAllByRole('listitem')).toHaveLength(3),
  );
  const others = within(list).getAllByRole('button', { name: /^Sign out:/ });
  await userEvent.click(others[0]!);
  await waitFor(() =>
    expect(within(list).getAllByRole('listitem')).toHaveLength(2),
  );
  expect(screen.getByText(/^Signed out /)).toBeInTheDocument();
  await userEvent.click(
    screen.getByRole('button', { name: 'Sign out all other devices' }),
  );
  await waitFor(() =>
    expect(within(list).getAllByRole('listitem')).toHaveLength(1),
  );
  expect(
    screen.getByRole('button', { name: 'Sign out all other devices' }),
  ).toBeDisabled();
});

test('change password requires the current password', async () => {
  useJar();
  await signup('s3@example.com');
  renderApp('/settings');
  await userEvent.type(
    await screen.findByLabelText('Current password'),
    'wrong-password-1',
  );
  await userEvent.type(
    screen.getByLabelText('New password'),
    'another-long-password',
  );
  await userEvent.click(
    screen.getByRole('button', { name: 'Change password' }),
  );
  expect(
    await screen.findByText('Current password is incorrect.'),
  ).toBeInTheDocument();
  await userEvent.clear(screen.getByLabelText('Current password'));
  await userEvent.type(screen.getByLabelText('Current password'), PW);
  await userEvent.click(
    screen.getByRole('button', { name: 'Change password' }),
  );
  expect(await screen.findByText('Password changed.')).toBeInTheDocument();
});

test('export goes pending then ready with a download link', async () => {
  useJar();
  await signup('s4@example.com');
  renderApp('/settings');
  await userEvent.click(
    await screen.findByRole('button', { name: 'Export my data' }),
  );
  expect(await screen.findByText('Preparing your export…')).toBeInTheDocument();
  expect(
    document.querySelector('[role="status"][aria-live="polite"]'),
  ).not.toBeNull();
  const link = await screen.findByRole(
    'link',
    { name: 'Download your data' },
    { timeout: 4000 },
  );
  expect(link).toHaveAttribute(
    'href',
    expect.stringContaining('/api/me/export'),
  );
});

test('expired export shows how to request a new one', async () => {
  const real = useJar();
  await signup('s5@example.com');
  http.fetch = (input, init) =>
    String(input).endsWith('/api/me/export-job')
      ? Promise.resolve(
          Response.json({
            job: { status: 'expired', requestedAt: new Date().toISOString() },
          }),
        )
      : real(input, init);
  renderApp('/settings');
  expect(
    await screen.findByText(/Your export has expired/),
  ).toBeInTheDocument();
  expect(
    screen.getByRole('button', { name: 'Request a new export' }),
  ).toBeEnabled();
});

function Probe() {
  return <output data-testid="probe">{useLocation().pathname}</output>;
}

test('delete dialog: warns, traps focus, Escape cancels and restores focus', async () => {
  useJar();
  await signup('s6@example.com');
  renderApp('/settings');
  const opener = await screen.findByRole('button', {
    name: /Delete my account/,
  });
  await userEvent.click(opener);
  const dialog = await screen.findByRole('dialog', {
    name: 'Delete your account?',
  });
  expect(dialog).toHaveTextContent('cannot be undone');
  expect(dialog).toHaveTextContent('30 days');
  expect(screen.getByLabelText('Your password')).toHaveFocus();
  expect((await axe(document.body)).violations).toEqual([]);
  // Tab cycles within the dialog (the delete button is disabled so the cancel button is last).
  await userEvent.tab();
  await userEvent.tab();
  expect(screen.getByRole('button', { name: 'Keep my account' })).toHaveFocus();
  await userEvent.tab();
  expect(screen.getByLabelText('Your password')).toHaveFocus();
  await userEvent.tab({ shift: true });
  expect(screen.getByRole('button', { name: 'Keep my account' })).toHaveFocus();
  await userEvent.keyboard('{Escape}');
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(opener).toHaveFocus();
});

test('delete needs password and exact phrase, then signs out', async () => {
  useJar();
  await signup('s7@example.com');
  render(
    <MemoryRouter initialEntries={['/settings']}>
      <AuthProvider>
        <App />
        <Probe />
      </AuthProvider>
    </MemoryRouter>,
  );
  await userEvent.click(
    await screen.findByRole('button', { name: /Delete my account/ }),
  );
  const del = screen.getByRole('button', {
    name: 'Permanently delete account',
  });
  await userEvent.type(
    screen.getByLabelText('Your password'),
    'wrong-password-1',
  );
  await userEvent.type(
    screen.getByLabelText(/Type DELETE MY ACCOUNT/),
    'delete my account',
  );
  expect(del).toBeDisabled();
  await userEvent.clear(screen.getByLabelText(/Type DELETE MY ACCOUNT/));
  await userEvent.type(
    screen.getByLabelText(/Type DELETE MY ACCOUNT/),
    'DELETE MY ACCOUNT',
  );
  expect(del).toBeEnabled();
  await userEvent.click(del);
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Password is incorrect.',
  );
  await userEvent.type(screen.getByLabelText('Your password'), PW);
  await userEvent.click(
    screen.getByRole('button', { name: 'Permanently delete account' }),
  );
  await waitFor(() =>
    expect(screen.getByTestId('probe')).toHaveTextContent('/'),
  );
  expect(screen.queryByRole('dialog')).toBeNull();
  const me = await http.fetch(`${http.base}/api/me`, {
    credentials: 'include',
  });
  expect(me.status).toBe(401);
});
