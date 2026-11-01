// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { useState } from 'react';
import { axe } from 'jest-axe';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { ConnectionStatus as Status } from './client.js';
import { RoomWaitState } from './RoomWaitState.js';
import {
  ROOM_STATE_TIMEOUT_MS,
  useRoomStateFailure,
} from './useRoomStateFailure.js';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function renderWait(props: Partial<Parameters<typeof RoomWaitState>[0]>) {
  return render(
    <MemoryRouter>
      <RoomWaitState
        status="connected"
        stalled={false}
        lobbyHref="/rooms/r1"
        {...props}
      />
    </MemoryRouter>,
  );
}

test('shows the waiting status while room state is still arriving', () => {
  renderWait({});

  expect(screen.getByText('Waiting for room state…')).toHaveAttribute(
    'role',
    'status',
  );
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
});

test('a stalled table explains the problem and offers retry and the lobby', () => {
  const onRetry = vi.fn();
  renderWait({ stalled: true, onRetry });

  expect(screen.getByRole('alert')).toHaveTextContent(
    'The table hasn’t answered yet.',
  );
  expect(screen.queryByText(/Waiting for room state/)).toBeNull();
  expect(
    screen.getByRole('link', { name: 'Back to the lobby' }),
  ).toHaveAttribute('href', '/rooms/r1');

  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(onRetry).toHaveBeenCalledTimes(1);
});

test('omits retry when it is unavailable, such as after a host removal', () => {
  renderWait({ stalled: true });

  expect(screen.getByRole('alert')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  expect(screen.getByRole('link', { name: 'Back to the lobby' })).toBeTruthy();
});

test('the stalled state has no critical accessibility violations', async () => {
  vi.useRealTimers();
  renderWait({ stalled: true, onRetry: () => {} });

  expect(
    (await axe(document.body)).violations.filter(
      (violation) => violation.impact === 'critical',
    ),
  ).toEqual([]);
});

/**
 * Stand-in for the room client: `connect` models the server answering a fresh
 * attempt with room state, so the retry path is exercised end to end.
 */
function WaitHarness({ answersRetry }: { answersRetry: boolean }) {
  const [status, setStatus] = useState<Status>('connected');
  const [attempt, setAttempt] = useState(0);
  const [hasRoom, setHasRoom] = useState(false);
  const stalled = useRoomStateFailure({
    hasRoom,
    connectionStatus: status,
    attempt,
  });

  if (hasRoom) return <p>Table is live</p>;
  return (
    <MemoryRouter>
      <RoomWaitState
        status={status}
        stalled={stalled}
        lobbyHref="/rooms/r1"
        onRetry={() => {
          setAttempt((n) => n + 1);
          setStatus('connecting');
          if (answersRetry) setHasRoom(true);
        }}
      />
    </MemoryRouter>
  );
}

test('waiting, then timeout, then error, then retry recovers the table', () => {
  render(<WaitHarness answersRetry />);

  expect(screen.getByText('Waiting for room state…')).toBeTruthy();

  act(() => {
    vi.advanceTimersByTime(ROOM_STATE_TIMEOUT_MS);
  });
  expect(screen.getByRole('alert')).toHaveTextContent(
    'The table hasn’t answered yet.',
  );

  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

  expect(screen.getByText('Table is live')).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
});

test('a retry that still gets no state returns to the error after another wait', () => {
  render(<WaitHarness answersRetry={false} />);

  act(() => {
    vi.advanceTimersByTime(ROOM_STATE_TIMEOUT_MS);
  });
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

  expect(screen.getByText('Waiting for room state…')).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();

  act(() => {
    vi.advanceTimersByTime(ROOM_STATE_TIMEOUT_MS);
  });
  expect(screen.getByRole('alert')).toHaveTextContent(
    'The table hasn’t answered yet.',
  );
});

test('a seat that could not reconnect shows the manual retry instead of waiting', () => {
  const onRetry = vi.fn();
  renderWait({ status: 'closed', reconnectGaveUp: true, onRetry });
  expect(screen.queryByText('Waiting for room state…')).toBeNull();
  expect(
    screen.getByText(/We couldn’t reconnect you to the table/),
  ).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(onRetry).toHaveBeenCalledTimes(1);
});
