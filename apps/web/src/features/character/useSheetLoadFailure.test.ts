// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  SHEET_CLOSED_GRACE_MS,
  SHEET_LOAD_TIMEOUT_MS,
  useSheetLoadFailure,
} from './useSheetLoadFailure.js';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

test('does not report failure while the room is still connecting', () => {
  const { result } = renderHook(() =>
    useSheetLoadFailure({
      hasCharacterState: false,
      connectionStatus: 'connecting',
    }),
  );

  act(() => {
    vi.advanceTimersByTime(SHEET_LOAD_TIMEOUT_MS - 1);
  });

  expect(result.current).toBe(false);
});

test('reports failure once the room has stalled past the timeout without state', () => {
  const { result } = renderHook(() =>
    useSheetLoadFailure({
      hasCharacterState: false,
      connectionStatus: 'connected',
    }),
  );

  act(() => {
    vi.advanceTimersByTime(SHEET_LOAD_TIMEOUT_MS);
  });

  expect(result.current).toBe(true);
});

test('reports failure quickly when the connection is closed', () => {
  const { result } = renderHook(() =>
    useSheetLoadFailure({
      hasCharacterState: false,
      connectionStatus: 'closed',
    }),
  );

  act(() => {
    vi.advanceTimersByTime(SHEET_CLOSED_GRACE_MS);
  });

  expect(result.current).toBe(true);
});

test('never reports failure once character state has arrived', () => {
  const { result, rerender } = renderHook(
    ({ hasCharacterState }) =>
      useSheetLoadFailure({ hasCharacterState, connectionStatus: 'closed' }),
    { initialProps: { hasCharacterState: false } },
  );

  rerender({ hasCharacterState: true });
  act(() => {
    vi.advanceTimersByTime(SHEET_LOAD_TIMEOUT_MS * 2);
  });

  expect(result.current).toBe(false);
});

test('clears a failure when the connection starts again and state is still pending', () => {
  const { result, rerender } = renderHook(
    ({ connectionStatus }) =>
      useSheetLoadFailure({ hasCharacterState: false, connectionStatus }),
    { initialProps: { connectionStatus: 'closed' as 'closed' | 'connecting' } },
  );

  act(() => {
    vi.advanceTimersByTime(SHEET_CLOSED_GRACE_MS);
  });
  expect(result.current).toBe(true);

  rerender({ connectionStatus: 'connecting' });

  expect(result.current).toBe(false);
});

test('unmounting clears the pending stall timer', () => {
  const before = vi.getTimerCount();
  const { unmount } = renderHook(() =>
    useSheetLoadFailure({
      hasCharacterState: false,
      connectionStatus: 'connected',
    }),
  );
  expect(vi.getTimerCount()).toBe(before + 1);

  unmount();

  expect(vi.getTimerCount()).toBe(before);
});
