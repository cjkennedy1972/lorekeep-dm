import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { axe } from 'jest-axe';
import {
  TurnTimerControl,
  describeTurnTimer,
  parseTurnTimerSeconds,
} from './TurnTimerControl';

describe('parseTurnTimerSeconds', () => {
  it('converts whole seconds in range to milliseconds', () => {
    expect(parseTurnTimerSeconds('90', false)).toEqual({
      ok: true,
      durationMs: 90_000,
    });
    expect(parseTurnTimerSeconds(' 30 ', false)).toEqual({
      ok: true,
      durationMs: 30_000,
    });
    expect(parseTurnTimerSeconds('600', false)).toEqual({
      ok: true,
      durationMs: 600_000,
    });
  });

  it('sends null when the timer is off, ignoring the entered number', () => {
    expect(parseTurnTimerSeconds('', true)).toEqual({
      ok: true,
      durationMs: null,
    });
  });

  it('rejects values below 30 s and above 600 s instead of clamping', () => {
    expect(parseTurnTimerSeconds('29', false)).toMatchObject({ ok: false });
    expect(parseTurnTimerSeconds('601', false)).toMatchObject({ ok: false });
    expect(parseTurnTimerSeconds('0', false)).toMatchObject({ ok: false });
  });

  it('rejects empty, non-numeric, and fractional entries', () => {
    expect(parseTurnTimerSeconds('', false)).toMatchObject({ ok: false });
    expect(parseTurnTimerSeconds('abc', false)).toMatchObject({ ok: false });
    expect(parseTurnTimerSeconds('45.5', false)).toMatchObject({ ok: false });
  });
});

describe('describeTurnTimer', () => {
  it('says the default applies when the setting was never configured', () => {
    expect(describeTurnTimer(undefined, undefined)).toBe(
      'Not set, so the server default applies.',
    );
  });

  it('describes off, and the seconds with the timeout action', () => {
    expect(describeTurnTimer(null, 'dodge')).toBe('Off.');
    expect(describeTurnTimer(120_000, 'hold')).toBe('120 seconds, then hold.');
    expect(describeTurnTimer(45_000, undefined)).toBe(
      '45 seconds, then dodge.',
    );
  });
});

describe('TurnTimerControl', () => {
  it('shows the current setting from state', () => {
    render(
      <TurnTimerControl
        turnTimerMs={120_000}
        turnTimeoutAction="hold"
        connected
        send={vi.fn(() => 'id')}
      />,
    );
    expect(screen.getByText('120 seconds, then hold.')).toBeInTheDocument();
    expect(screen.getByLabelText(/Turn timer in seconds/)).toHaveValue(120);
    expect(screen.getByRole('radio', { name: 'Hold' })).toBeChecked();
  });

  it('sends ConfigureTurnTimer with the millisecond duration and chosen action', () => {
    const send = vi.fn(() => 'id');
    render(
      <TurnTimerControl
        turnTimerMs={undefined}
        turnTimeoutAction={undefined}
        connected
        send={send}
      />,
    );
    fireEvent.change(screen.getByLabelText(/Turn timer in seconds/), {
      target: { value: '75' },
    });
    fireEvent.click(screen.getByRole('radio', { name: 'Hold' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save turn timer' }));
    expect(send).toHaveBeenCalledWith('ConfigureTurnTimer', {
      durationMs: 75_000,
      timeoutAction: 'hold',
    });
    expect(screen.getByRole('status')).toHaveTextContent(
      'Turn timer saved. It applies from the next turn opened.',
    );
  });

  it('sends null duration when the timer is turned off', () => {
    const send = vi.fn(() => 'id');
    render(
      <TurnTimerControl
        turnTimerMs={90_000}
        turnTimeoutAction="dodge"
        connected
        send={send}
      />,
    );
    fireEvent.click(screen.getByLabelText('Turn timer off'));
    expect(screen.getByLabelText(/Turn timer in seconds/)).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Save turn timer' }));
    expect(send).toHaveBeenCalledWith('ConfigureTurnTimer', {
      durationMs: null,
      timeoutAction: 'dodge',
    });
  });

  it('shows a validation error and does not send an out-of-range value', () => {
    const send = vi.fn(() => 'id');
    render(
      <TurnTimerControl
        turnTimerMs={undefined}
        turnTimeoutAction={undefined}
        connected
        send={send}
      />,
    );
    const input = screen.getByLabelText(/Turn timer in seconds/);
    fireEvent.change(input, { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save turn timer' }));
    expect(send).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('30 to 600 seconds');
    expect(input).toHaveAttribute('aria-invalid', 'true');
  });

  it('reports when the change could not be sent because the socket is down', () => {
    const send = vi.fn(() => false as const);
    render(
      <TurnTimerControl
        turnTimerMs={undefined}
        turnTimeoutAction={undefined}
        connected
        send={send}
      />,
    );
    fireEvent.change(screen.getByLabelText(/Turn timer in seconds/), {
      target: { value: '60' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save turn timer' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Not connected');
  });

  it('disables save while disconnected', () => {
    render(
      <TurnTimerControl
        turnTimerMs={undefined}
        turnTimeoutAction={undefined}
        connected={false}
        send={vi.fn(() => 'id')}
      />,
    );
    expect(
      screen.getByRole('button', { name: 'Save turn timer' }),
    ).toBeDisabled();
  });

  it('has labelled controls and no axe violations', async () => {
    const { container } = render(
      <TurnTimerControl
        turnTimerMs={60_000}
        turnTimeoutAction="dodge"
        connected
        send={vi.fn(() => 'id')}
      />,
    );
    expect(
      screen.getByRole('group', { name: 'When the timer runs out' }),
    ).toBeInTheDocument();
    expect((await axe(container)).violations).toEqual([]);
  });
});
