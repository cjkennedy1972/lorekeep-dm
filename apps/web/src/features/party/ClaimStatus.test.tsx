// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { describe, expect, test, vi } from 'vitest';
import { ClaimStatus } from './ClaimStatus';

const base = {
  mySeatId: null,
  bound: false,
  inPlay: true,
  deviceClaim: null,
  now: 1_000_000,
  askWaitSeconds: 0,
  onAskAgain: () => {},
};

describe('ClaimStatus', () => {
  test('renders nothing once the seat is bound', () => {
    const { container } = render(
      <ClaimStatus {...base} bound deviceClaim={{ status: 'expired' }} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  test('pending claim: says the host approved and counts down the confirmation', async () => {
    render(
      <ClaimStatus
        {...base}
        deviceClaim={{ status: 'pending', expiresAt: 1_000_000 + 45_000 }}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      'Approved by the host. Waiting for the host to confirm your device.',
    );
    expect(
      screen.getByText('The host has 45 seconds to confirm.'),
    ).toBeInTheDocument();
    expect(
      (await axe(document.body)).violations.filter(
        (violation) => violation.impact === 'critical',
      ),
    ).toEqual([]);
  });

  test('expired claim: a clear timeout message and an enabled Ask again', async () => {
    const onAskAgain = vi.fn();
    render(
      <ClaimStatus
        {...base}
        deviceClaim={{ status: 'expired' }}
        onAskAgain={onAskAgain}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(
      'That request timed out.',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Ask again' }));
    expect(onAskAgain).toHaveBeenCalledOnce();
  });

  test('Ask again shows the limiter wait and is disabled while it runs', () => {
    render(
      <ClaimStatus
        {...base}
        deviceClaim={{ status: 'expired' }}
        askWaitSeconds={90}
      />,
    );
    expect(screen.getByRole('button', { name: 'Ask again' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent(
      'You can ask again in 90 seconds.',
    );
  });

  test('denied claim says the host did not confirm the device', () => {
    render(<ClaimStatus {...base} deviceClaim={{ status: 'denied' }} />);
    expect(screen.getByRole('alert')).toHaveTextContent(
      'The host did not confirm your device.',
    );
  });

  test('seated but unbound in a live table: says the seat joins at the next round', () => {
    render(<ClaimStatus {...base} mySeatId="seat-2" />);
    expect(screen.getByRole('status')).toHaveTextContent(
      'You are in. Joining at the start of the next round.',
    );
  });

  test('seated but unbound in a fresh table: no late-join copy', () => {
    const { container } = render(
      <ClaimStatus {...base} mySeatId="seat-2" inPlay={false} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
