import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { axe } from 'jest-axe';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Character } from '@game/schema';
import { MemoryRouter } from 'react-router-dom';
import { SaveToAccount } from './SaveToAccount';

const apiMock = vi.hoisted(() => vi.fn());
const authMock = vi.hoisted(() => vi.fn());
vi.mock('../../api', () => ({ api: apiMock }));
vi.mock('../../auth', () => ({ useAuth: authMock }));

const character = {
  id: 'character:fighter',
  name: 'Mira',
  classId: 'class:fighter',
  speciesId: 'species:human',
  backgroundId: 'background:soldier',
  level: 1,
} as unknown as Character;

const SAVED = {
  id: '00000000-0000-4000-8000-0000000000c1',
  revision: 1,
  name: 'Mira',
  classId: 'class:fighter',
  speciesId: 'species:human',
  level: 1,
};

function renderSave() {
  return render(
    <MemoryRouter>
      <SaveToAccount character={character} />
    </MemoryRouter>,
  );
}

function failWith(status: number, code: string) {
  apiMock.mockResolvedValueOnce({
    ok: false,
    status,
    code,
    message: 'server text',
  });
}

beforeEach(() => {
  apiMock.mockReset();
  authMock.mockReturnValue({
    account: { id: 'a1', displayName: 'Mira Owner' },
    setAccount: vi.fn(),
  });
});
afterEach(() => cleanup());

describe('SaveToAccount', () => {
  test('renders nothing for a signed-out visitor', () => {
    authMock.mockReturnValue({ account: null, setAccount: vi.fn() });
    const { container } = renderSave();
    expect(container).toBeEmptyDOMElement();
  });

  test('posts the sheet without a local id and confirms the saved name', async () => {
    apiMock.mockResolvedValueOnce({
      ok: true,
      status: 201,
      data: SAVED,
    });
    renderSave();
    fireEvent.click(screen.getByRole('button', { name: 'Save to my account' }));

    expect(
      await screen.findByText(/Mira is saved to your account/),
    ).toBeInTheDocument();
    expect(apiMock).toHaveBeenCalledTimes(1);
    const [path, body] = apiMock.mock.calls[0]!;
    expect(path).toBe('/api/me/characters');
    expect(Object.keys(body as object)).toEqual(['character']);
    expect((body as { character: object }).character).not.toHaveProperty('id');
    expect(
      screen.queryByRole('button', { name: 'Save to my account' }),
    ).toBeNull();
    expect(
      screen.getByRole('link', { name: 'Go to my games' }),
    ).toHaveAttribute('href', '/rooms');
  });

  test('ignores a second click while the first save is in flight', async () => {
    let finish!: (value: unknown) => void;
    apiMock.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    renderSave();
    const button = screen.getByRole('button', { name: 'Save to my account' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(apiMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status')).toHaveTextContent('Saving');
    finish({ ok: true, status: 201, data: SAVED });
    expect(
      await screen.findByText(/Mira is saved to your account/),
    ).toBeInTheDocument();
  });

  test.each([
    [400, 'INVALID_CHARACTER', /some details are not valid/],
    [429, 'RATE_LIMITED', /Too many saves right now/],
    [403, 'ACCOUNT_INACTIVE', /account is inactive/],
    [0, 'NETWORK', /Check your connection/],
  ])(
    '%s %s shows its own alert and keeps the save available',
    async (status, code, copy) => {
      failWith(status, code);
      renderSave();
      fireEvent.click(
        screen.getByRole('button', { name: 'Save to my account' }),
      );
      expect(await screen.findByRole('alert')).toHaveTextContent(copy);
      expect(
        screen.getByRole('button', { name: 'Save to my account' }),
      ).toBeEnabled();
      expect(screen.queryByRole('link', { name: 'Sign in' })).toBeNull();
    },
  );

  test('a lost session names the problem and links to sign in', async () => {
    failWith(401, 'UNAUTHENTICATED');
    renderSave();
    fireEvent.click(screen.getByRole('button', { name: 'Save to my account' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/Sign in again/);
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute(
      'href',
      '/login',
    );
  });

  test('a retry after a failure can succeed', async () => {
    failWith(429, 'RATE_LIMITED');
    apiMock.mockResolvedValueOnce({ ok: true, status: 201, data: SAVED });
    renderSave();
    const button = screen.getByRole('button', { name: 'Save to my account' });
    fireEvent.click(button);
    await screen.findByRole('alert');
    fireEvent.click(button);
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(
        'Mira is saved to your account',
      ),
    );
    expect(apiMock).toHaveBeenCalledTimes(2);
  });

  test('has no axe violations before and after saving', async () => {
    apiMock.mockResolvedValueOnce({ ok: true, status: 201, data: SAVED });
    const { container } = renderSave();
    expect((await axe(container)).violations).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Save to my account' }));
    await screen.findByText(/Mira is saved to your account/);
    expect((await axe(container)).violations).toEqual([]);
  });
});
