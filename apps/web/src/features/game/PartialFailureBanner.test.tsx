// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { PartialFailureBanner } from './PartialFailureBanner.js';

const message =
  'The DM could not apply part of that action. The rest of the turn may still have succeeded.';

test('a partial failure is an alert with its full message', () => {
  render(<PartialFailureBanner message={message} onDismiss={() => {}} />);

  const alert = screen.getByRole('alert');
  expect(alert).toHaveTextContent(message);
});

test('the banner can be dismissed with a real button', () => {
  const onDismiss = vi.fn();
  render(<PartialFailureBanner message={message} onDismiss={onDismiss} />);

  fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
  expect(onDismiss).toHaveBeenCalledTimes(1);
});
