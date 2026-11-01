import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  RECONNECT_NOTICE_DELAY_MS,
  TableConnectionNotice,
} from './TableConnectionNotice.js';

const NOTICE = /connection to the table lost/i;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

test('shows nothing while the table is connected', () => {
  render(<TableConnectionNotice status="connected" />);
  expect(screen.queryByText(NOTICE)).toBeNull();
});

test('a brief reconnect mid-combat does not flash a notice over the story', () => {
  const { rerender } = render(<TableConnectionNotice status="connected" />);
  rerender(<TableConnectionNotice status="reconnecting" />);
  act(() => {
    vi.advanceTimersByTime(RECONNECT_NOTICE_DELAY_MS - 1);
  });
  expect(screen.queryByText(NOTICE)).toBeNull();
  rerender(<TableConnectionNotice status="connected" />);
  act(() => {
    vi.advanceTimersByTime(RECONNECT_NOTICE_DELAY_MS * 5);
  });
  expect(screen.queryByText(NOTICE)).toBeNull();
});

test('a reconnect that lasts shows a notice without interrupting as an alert', () => {
  render(<TableConnectionNotice status="reconnecting" />);
  act(() => {
    vi.advanceTimersByTime(RECONNECT_NOTICE_DELAY_MS);
  });
  const notice = screen.getByText(NOTICE);
  expect(notice).toHaveTextContent('Reconnecting');
  expect(notice).toHaveTextContent('Your game is safe');
  expect(screen.queryByRole('alert')).toBeNull();
});

test('a lasting reconnect is announced politely through a live region', () => {
  const { rerender } = render(<TableConnectionNotice status="connected" />);
  const region = screen.getByRole('status');
  expect(region).toHaveAttribute('aria-live', 'polite');
  rerender(<TableConnectionNotice status="reconnecting" />);
  act(() => {
    vi.advanceTimersByTime(RECONNECT_NOTICE_DELAY_MS);
  });
  expect(screen.getByRole('status')).toHaveTextContent(NOTICE);
});

test('a closed seat is not told the table will reconnect', () => {
  render(<TableConnectionNotice status="closed" />);
  act(() => {
    vi.advanceTimersByTime(RECONNECT_NOTICE_DELAY_MS * 5);
  });
  expect(screen.queryByText(NOTICE)).toBeNull();
});

test('a reconnect that gave up offers a manual retry and stops claiming to reconnect', () => {
  const onRetry = vi.fn();
  render(
    <TableConnectionNotice status="closed" reconnectGaveUp onRetry={onRetry} />,
  );
  const notice = screen.getByRole('status');
  expect(notice).toHaveTextContent('We couldn’t reconnect you to the table');
  expect(notice).toHaveTextContent('select Retry');
  expect(notice).not.toHaveTextContent(/reconnecting/i);
  // Neutral copy: no record ids and no security detail.
  expect(notice.textContent).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/i);
  expect(notice.textContent).not.toMatch(/authenticat|token|seat/i);

  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(onRetry).toHaveBeenCalledTimes(1);
});
