import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { Join } from './Join';

const apiMock = vi.hoisted(() => vi.fn());
vi.mock('../api', () => ({ api: apiMock }));

const CODE = 'ABC123';
const PENDING_MESSAGE =
  'Your request is waiting for the host. Retry this invite after it is approved.';
const ALDRIC = {
  id: '00000000-0000-4000-8000-0000000000f1',
  name: 'Aldric Vane',
  classId: 'class:fighter',
  speciesId: 'species:human',
  level: 3,
  revision: 4,
};
const BRENNA = {
  id: '00000000-0000-4000-8000-0000000000f2',
  name: 'Brenna Holt',
  classId: 'class:wizard',
  speciesId: 'species:elf',
  level: 3,
  revision: 1,
};

type Handler = (path: string, body?: unknown) => unknown;

/** Routes each api call by path. Unlisted paths answer with an empty success. */
function serve(routes: Record<string, Handler>) {
  apiMock.mockImplementation(async (path: string, body?: unknown) => {
    const handler = routes[path] ?? (() => ({}));
    const data = handler(path, body) as Record<string, unknown>;
    if (data && 'code' in data)
      return {
        ok: false,
        status: 409,
        code: data.code,
        message: data.message,
        data,
      };
    return { ok: true, status: 200, data };
  });
}

function baseRoutes(characters: unknown[] = [ALDRIC, BRENNA]) {
  return {
    [`/api/invites/${CODE}`]: () => ({
      room: {
        id: 'room-1',
        name: 'Tavern Table',
        isHost: false,
        tierCap: null,
      },
    }),
    '/api/me': () => ({ account: { matureOptOut: false } }),
    '/api/me/characters': () => ({ characters }),
  };
}

function renderJoin() {
  return render(
    <MemoryRouter initialEntries={[`/join/${CODE}`]}>
      <Routes>
        <Route path="/join/:code" element={<Join />} />
      </Routes>
    </MemoryRouter>,
  );
}

type JoinBody = { actionId: string } & Record<string, unknown>;

function joinBodies(): JoinBody[] {
  return joinCalls().map(([, body]) => body as JoinBody);
}

function joinCalls() {
  return apiMock.mock.calls.filter(
    ([path]) => path === `/api/invites/${CODE}/join`,
  );
}

beforeEach(() => {
  apiMock.mockReset();
});

afterEach(() => cleanup());

describe('Join: late-join character selection', () => {
  test('a running table gets the chosen character at its revision, and the pending state takes focus', async () => {
    serve({
      ...baseRoutes(),
      [`/api/invites/${CODE}/join`]: () => ({
        code: 'LATE_JOIN_PENDING',
        message: PENDING_MESSAGE,
        requestId: '00000000-0000-4000-8000-0000000000aa',
      }),
    });
    renderJoin();
    const picker = await screen.findByRole('combobox', {
      name: 'Your character',
    });
    expect(picker).toHaveValue(ALDRIC.id);

    await userEvent.click(screen.getByRole('button', { name: 'Join table' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(PENDING_MESSAGE);
    await waitFor(() => expect(alert).toHaveFocus());
    expect(picker).toBeDisabled();

    const [body] = joinBodies();
    expect(body).toMatchObject({
      matureOptOut: false,
      characterId: ALDRIC.id,
      expectedRevision: ALDRIC.revision,
    });
    expect(body?.actionId).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('a retry of the same pending pick reuses its actionId so the server returns the prior result', async () => {
    serve({
      ...baseRoutes(),
      [`/api/invites/${CODE}/join`]: () => ({
        code: 'LATE_JOIN_PENDING',
        message: PENDING_MESSAGE,
      }),
    });
    renderJoin();
    await screen.findByRole('combobox', { name: 'Your character' });
    const join = screen.getByRole('button', { name: 'Join table' });

    await userEvent.click(join);
    await screen.findByRole('alert');
    await userEvent.click(join);

    await waitFor(() => expect(joinCalls()).toHaveLength(2));
    const [first, second] = joinBodies();
    expect(first?.actionId).toBe(second?.actionId);
  });

  test('a changed character is a new request with a new actionId', async () => {
    serve({
      ...baseRoutes(),
      [`/api/invites/${CODE}/join`]: () => ({
        code: 'CHARACTER_UNAVAILABLE',
        message: 'Character could not be selected.',
      }),
    });
    renderJoin();
    const picker = await screen.findByRole('combobox', {
      name: 'Your character',
    });
    await userEvent.click(screen.getByRole('button', { name: 'Join table' }));
    await screen.findByText('Character could not be selected.');

    await userEvent.selectOptions(picker, BRENNA.id);
    await userEvent.click(screen.getByRole('button', { name: 'Join table' }));

    await waitFor(() => expect(joinCalls()).toHaveLength(2));
    const [first, second] = joinBodies();
    expect(second).toMatchObject({
      characterId: BRENNA.id,
      expectedRevision: 1,
    });
    expect(second?.actionId).not.toBe(first?.actionId);
  });

  test('a failed character list shows a neutral message with a retry, and Join waits for it', async () => {
    let fail = true;
    apiMock.mockImplementation(async (path: string) => {
      if (path === '/api/me/characters' && fail)
        return { ok: false, status: 500, code: 'ERROR', message: 'boom' };
      if (path === `/api/invites/${CODE}`)
        return {
          ok: true,
          status: 200,
          data: {
            room: { id: 'room-1', name: 'Tavern Table', isHost: false },
          },
        };
      if (path === '/api/me')
        return {
          ok: true,
          status: 200,
          data: { account: { matureOptOut: false } },
        };
      if (path === '/api/me/characters')
        return { ok: true, status: 200, data: { characters: [ALDRIC] } };
      return { ok: true, status: 200, data: {} };
    });
    renderJoin();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Your characters could not be loaded.');
    // A table that is not playing joins without a character, so Join stays available.
    expect(screen.getByRole('button', { name: 'Join table' })).toBeEnabled();

    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(
      await screen.findByRole('combobox', { name: 'Your character' }),
    ).toHaveValue(ALDRIC.id);
    expect(screen.getByRole('button', { name: 'Join table' })).toBeEnabled();
  });
});

describe('Join: late-join recap while pending', () => {
  const REQUEST_ID = '00000000-0000-4000-8000-0000000000aa';
  const pendingRoutes = (recap: () => unknown) => ({
    ...baseRoutes(),
    [`/api/invites/${CODE}/join`]: () => ({
      code: 'LATE_JOIN_PENDING',
      message: PENDING_MESSAGE,
      requestId: REQUEST_ID,
      settings: { contentTier: 'standard', lines: ['spiders'] },
    }),
    [`/api/late-join/${REQUEST_ID}/recap`]: recap,
  });

  test('shows the recap with the table settings in a live region before approval', async () => {
    serve(pendingRoutes(() => ({ recap: 'The party reached the hollow.' })));
    renderJoin();
    await screen.findByRole('combobox', { name: 'Your character' });
    await userEvent.click(screen.getByRole('button', { name: 'Join table' }));

    const text = await screen.findByText('The party reached the hollow.');
    expect(text.parentElement).toHaveAttribute('aria-live', 'polite');
    expect(screen.getByText('Lines: spiders')).toBeInTheDocument();
  });

  test('a recap failure is neutral and does not block waiting or withdrawing', async () => {
    serve(
      pendingRoutes(() => ({ code: 'NOT_FOUND', message: 'internal detail' })),
    );
    renderJoin();
    await screen.findByRole('combobox', { name: 'Your character' });
    await userEvent.click(screen.getByRole('button', { name: 'Join table' }));

    expect(
      await screen.findByText(/recap is not available right now/),
    ).toBeInTheDocument();
    expect(screen.queryByText('internal detail')).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Withdraw request' }),
    ).toBeEnabled();
  });

  test('withdrawing cancels the request and clears the recap', async () => {
    serve({
      ...pendingRoutes(() => ({ recap: 'The party reached the hollow.' })),
      [`/api/late-join/${REQUEST_ID}/cancel`]: () => ({ ok: true }),
    });
    renderJoin();
    await screen.findByRole('combobox', { name: 'Your character' });
    await userEvent.click(screen.getByRole('button', { name: 'Join table' }));
    await userEvent.click(
      await screen.findByRole('button', { name: 'Withdraw request' }),
    );

    expect(
      await screen.findByText('Your join request was withdrawn.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('The party reached the hollow.')).toBeNull();
    const cancel = apiMock.mock.calls.find(
      ([path]) => path === `/api/late-join/${REQUEST_ID}/cancel`,
    );
    expect(cancel?.[1]).toMatchObject({ requestId: REQUEST_ID });
  });

  test('a failed withdraw keeps the panel and shows a neutral error', async () => {
    serve({
      ...pendingRoutes(() => ({ recap: 'The party reached the hollow.' })),
      [`/api/late-join/${REQUEST_ID}/cancel`]: () => ({
        code: 'NOT_FOUND',
        message: 'internal detail',
      }),
    });
    renderJoin();
    await screen.findByRole('combobox', { name: 'Your character' });
    await userEvent.click(screen.getByRole('button', { name: 'Join table' }));
    await userEvent.click(
      await screen.findByRole('button', { name: 'Withdraw request' }),
    );

    expect(
      await screen.findByText(/could not be withdrawn/),
    ).toBeInTheDocument();
    expect(screen.queryByText('internal detail')).toBeNull();
    expect(screen.getByText('The party reached the hollow.')).toBeVisible();
  });
});
