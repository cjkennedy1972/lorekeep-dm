// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { Sheet } from './Sheet.js';

test('shows a recoverable failure message with retry when the character never arrives', () => {
  const onRetry = vi.fn();
  render(<Sheet character={null} loadFailed onRetry={onRetry} />);

  expect(screen.getByRole('alert')).toHaveTextContent(
    'Your character hasn’t made it to the table yet.',
  );
  expect(screen.queryByText(/Loading your character/)).toBeNull();
  expect(screen.queryByText('No character selected.')).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(onRetry).toHaveBeenCalledTimes(1);
});

test('omits the retry button when no retry is available', () => {
  render(<Sheet character={null} loadFailed />);

  expect(screen.getByRole('alert')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
});

test('a failed load takes precedence over the loading status', () => {
  render(<Sheet character={null} loading loadFailed onRetry={() => {}} />);

  expect(screen.queryByRole('status')).toBeNull();
  expect(screen.getByRole('alert')).toBeTruthy();
});
