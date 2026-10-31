// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  ROOM_CLOSED_GRACE_MS,
  ROOM_STATE_TIMEOUT_MS,
  useRoomStateFailure,
} from './useRoomStateFailure.js';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

test('does not report failure while the table is still connecting', () => {
  const { result } = renderHook(() =>
    useRoomStateFailure({ hasRoom: false, connectionStatus: 'connecting' }),
  );

  act(() => {
    vi.advanceTimersByTime(ROOM_STATE_TIMEOUT_MS - 1);
  });

  expect(result.current).toBe(false);
});

test('reports failure once a connected table stalls without room state', () => {
  const { result } = renderHook(() =>
    useRoomStateFailure({ hasRoom: false, connectionStatus: 'connected' }),
  );

  act(() => {
    vi.advanceTimersByTime(ROOM_STATE_TIMEOUT_MS);
  });

  expect(result.current).toBe(true);
});

test('reports failure quickly when the connection is closed', () => {
  const { result } = renderHook(() =>
    useRoomStateFailure({ hasRoom: false, connectionStatus: 'closed' }),
  );

  act(() => {
    vi.advanceTimersByTime(ROOM_CLOSED_GRACE_MS);
  });

  expect(result.current).toBe(true);
});

test('never reports failure once the room has arrived', () => {
  const { result, rerender } = renderHook(
    ({ hasRoom }) =>
      useRoomStateFailure({ hasRoom, connectionStatus: 'closed' }),
    { initialProps: { hasRoom: false } },
  );

  rerender({ hasRoom: true });
  act(() => {
    vi.advanceTimersByTime(ROOM_STATE_TIMEOUT_MS * 2);
  });

  expect(result.current).toBe(false);
});

test('clears a failure when the connection starts again and the room is still pending', () => {
  const { result, rerender } = renderHook(
    ({ connectionStatus }) =>
      useRoomStateFailure({ hasRoom: false, connectionStatus }),
    { initialProps: { connectionStatus: 'closed' as 'closed' | 'connecting' } },
  );

  act(() => {
    vi.advanceTimersByTime(ROOM_CLOSED_GRACE_MS);
  });
  expect(result.current).toBe(true);

  rerender({ connectionStatus: 'connecting' });

  expect(result.current).toBe(false);
});

test('a retry restarts the wait even when the status is already connecting', () => {
  const { result, rerender } = renderHook(
    ({ attempt }) =>
      useRoomStateFailure({
        hasRoom: false,
        connectionStatus: 'connecting',
        attempt,
      }),
    { initialProps: { attempt: 0 } },
  );

  act(() => {
    vi.advanceTimersByTime(ROOM_STATE_TIMEOUT_MS);
  });
  expect(result.current).toBe(true);

  rerender({ attempt: 1 });

  expect(result.current).toBe(false);
});

test('unmounting clears the pending stall timer', () => {
  const before = vi.getTimerCount();
  const { unmount } = renderHook(() =>
    useRoomStateFailure({ hasRoom: false, connectionStatus: 'connected' }),
  );
  expect(vi.getTimerCount()).toBe(before + 1);

  unmount();

  expect(vi.getTimerCount()).toBe(before);
});
