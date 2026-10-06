import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import { ConnectionStatus } from './ConnectionStatus.js';

test('announces connection state through a polite live region', () => {
  const { rerender } = render(<ConnectionStatus status="connected" />);
  const region = screen.getByRole('status');
  expect(region).toHaveAttribute('aria-live', 'polite');
  expect(region).toHaveTextContent('Connected');
  rerender(<ConnectionStatus status="reconnecting" />);
  expect(screen.getByRole('status')).toHaveTextContent('Reconnecting');
});
