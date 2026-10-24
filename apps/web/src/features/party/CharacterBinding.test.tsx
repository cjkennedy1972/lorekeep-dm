import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { CharacterBinding, type BindServerError } from './CharacterBinding';

const apiMock = vi.hoisted(() => vi.fn());
vi.mock('../../api', () => ({ api: apiMock }));

const ALDRIC = {
  id: '00000000-0000-4000-8000-0000000000f1',
  name: 'Aldric Vane',
  species: 'Human',
  className: 'Fighter',
  level: 3,
  revision: 4,
};
const BRENNA = {
  id: '00000000-0000-4000-8000-0000000000f2',
  name: 'Brenna Holt',
  species: 'Elf',
  className: 'Wizard',
  level: 2,
  revision: 1,
};
const ACTION = '00000000-0000-4000-8000-0000000000e9';

function listed(characters = [ALDRIC, BRENNA]) {
  apiMock.mockResolvedValue({ ok: true, status: 200, data: { characters } });
}

beforeEach(() => {
  apiMock.mockReset();
});
afterEach(() => cleanup());

describe('CharacterBinding', () => {
  test('lists owned characters and binds the chosen one at its revision', async () => {
    listed();
    const send = vi.fn(() => ACTION);
    render(<CharacterBinding bound={false} send={send} serverError={null} />);

    const picker = await screen.findByLabelText('Your character');
    fireEvent.change(picker, { target: { value: BRENNA.id } });
    fireEvent.click(screen.getByRole('button', { name: 'Bind character' }));

    expect(send).toHaveBeenCalledWith('BindCharacter', {
      characterId: BRENNA.id,
      expectedRevision: 1,
    });
    expect(await screen.findByText('Binding your character…')).toBeTruthy();
  });

  test('shows the bound state with no picker once the seat is bound', () => {
    listed();
    render(<CharacterBinding bound send={vi.fn()} serverError={null} />);
    expect(screen.getByRole('status').textContent).toMatch(/bound/i);
    expect(screen.queryByRole('button', { name: 'Bind character' })).toBeNull();
  });

  test('a server error for this bind is shown as its mapped message', async () => {
    listed();
    const send = vi.fn(() => ACTION);
    const { rerender } = render(
      <CharacterBinding bound={false} send={send} serverError={null} />,
    );
    fireEvent.click(
      await screen.findByRole('button', { name: 'Bind character' }),
    );
    const error: BindServerError = {
      actionId: ACTION,
      code: 'ALREADY_BOUND',
      message: 'raw server text',
    };
    rerender(
      <CharacterBinding bound={false} send={send} serverError={error} />,
    );
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toMatch(/already has/i);
    expect(screen.getByRole('button', { name: 'Bind character' })).toBeTruthy();
  });

  test('an error for a different action is ignored', async () => {
    listed();
    const send = vi.fn(() => ACTION);
    const { rerender } = render(
      <CharacterBinding bound={false} send={send} serverError={null} />,
    );
    fireEvent.click(
      await screen.findByRole('button', { name: 'Bind character' }),
    );
    rerender(
      <CharacterBinding
        bound={false}
        send={send}
        serverError={{
          actionId: '00000000-0000-4000-8000-0000000000aa',
          code: 'NOT_OWNER',
          message: 'x',
        }}
      />,
    );
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('Binding your character…')).toBeTruthy();
  });

  test('a stale revision offers a reload that refetches the list', async () => {
    listed();
    const send = vi.fn(() => ACTION);
    const { rerender } = render(
      <CharacterBinding bound={false} send={send} serverError={null} />,
    );
    fireEvent.click(
      await screen.findByRole('button', { name: 'Bind character' }),
    );
    rerender(
      <CharacterBinding
        bound={false}
        send={send}
        serverError={{ actionId: ACTION, code: 'STALE_REVISION', message: 'x' }}
      />,
    );
    const reload = await screen.findByRole('button', {
      name: 'Reload characters',
    });
    expect(apiMock).toHaveBeenCalledTimes(1);
    fireEvent.click(reload);
    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('reports when the socket is closed instead of sending', async () => {
    listed();
    render(
      <CharacterBinding
        bound={false}
        send={vi.fn((): string | false => false)}
        serverError={null}
      />,
    );
    fireEvent.click(
      await screen.findByRole('button', { name: 'Bind character' }),
    );
    expect(screen.getByRole('alert').textContent).toMatch(/not connected/i);
  });

  test('explains when the account has no characters', async () => {
    listed([]);
    render(
      <CharacterBinding bound={false} send={vi.fn()} serverError={null} />,
    );
    expect(await screen.findByText(/no characters yet/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Bind character' })).toBeNull();
  });

  test('a failed list load shows an alert with a retry', async () => {
    apiMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      code: 'ERROR',
      message: 'boom',
    });
    listed();
    render(
      <CharacterBinding bound={false} send={vi.fn()} serverError={null} />,
    );
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /could not be loaded/i,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByLabelText('Your character')).toBeTruthy();
  });
});
