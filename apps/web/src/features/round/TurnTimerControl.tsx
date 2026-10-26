import { useEffect, useId, useState, type FormEvent } from 'react';
import type { RoomState } from '@game/schema';
import type { RoomSend } from './RoundPanel';
import './round.css';

/** Turn timer bounds from ADR-033 §5.1 (30 s floor) and the M4 item 3 cap (600 s). */
export const TURN_TIMER_MIN_S = 30;
export const TURN_TIMER_MAX_S = 600;

export type TimeoutAction = 'dodge' | 'hold';

export type TurnTimerInput =
  | { ok: true; durationMs: number | null }
  | { ok: false; error: string };

/**
 * Validates the host's turn-timer entry. Unlike the round timer, out-of-range
 * values are rejected rather than clamped, because the server rejects them too.
 */
export function parseTurnTimerSeconds(
  raw: string,
  off: boolean,
): TurnTimerInput {
  if (off) return { ok: true, durationMs: null };
  const text = raw.trim();
  if (text === '') {
    return {
      ok: false,
      error: 'Enter a number of seconds, or turn the timer off.',
    };
  }
  const seconds = Number(text);
  if (!Number.isFinite(seconds) || !Number.isInteger(seconds)) {
    return { ok: false, error: 'Enter a whole number of seconds.' };
  }
  if (seconds < TURN_TIMER_MIN_S || seconds > TURN_TIMER_MAX_S) {
    return {
      ok: false,
      error: `Enter a value from ${TURN_TIMER_MIN_S} to ${TURN_TIMER_MAX_S} seconds, or turn the timer off.`,
    };
  }
  return { ok: true, durationMs: seconds * 1000 };
}

/** Describes the configured setting from room state. Undefined means the server default applies. */
export function describeTurnTimer(
  durationMs: number | null | undefined,
  timeoutAction: TimeoutAction | undefined,
): string {
  if (durationMs === undefined) {
    return 'Not set, so the server default applies.';
  }
  const action = timeoutAction === 'hold' ? 'hold' : 'dodge';
  if (durationMs === null) return 'Off.';
  return `${durationMs / 1000} seconds, then ${action}.`;
}

type Props = {
  turnTimerMs: RoomState['turnTimerMs'];
  turnTimeoutAction: RoomState['turnTimeoutAction'];
  connected: boolean;
  send: RoomSend;
};

export function TurnTimerControl({
  turnTimerMs,
  turnTimeoutAction,
  connected,
  send,
}: Props) {
  const id = useId();
  const [off, setOff] = useState(turnTimerMs === null);
  const [seconds, setSeconds] = useState(
    typeof turnTimerMs === 'number' ? String(turnTimerMs / 1000) : '',
  );
  const [action, setAction] = useState<TimeoutAction>(
    turnTimeoutAction ?? 'dodge',
  );
  const [error, setError] = useState('');
  const [note, setNote] = useState('');

  // Re-sync the form when the server's setting changes, so it shows what is in force.
  useEffect(() => {
    setOff(turnTimerMs === null);
    setSeconds(
      typeof turnTimerMs === 'number' ? String(turnTimerMs / 1000) : '',
    );
  }, [turnTimerMs]);
  useEffect(() => {
    setAction(turnTimeoutAction ?? 'dodge');
  }, [turnTimeoutAction]);

  function save(e: FormEvent) {
    e.preventDefault();
    const parsed = parseTurnTimerSeconds(seconds, off);
    if (!parsed.ok) {
      setError(parsed.error);
      setNote('');
      return;
    }
    const sent = send('ConfigureTurnTimer', {
      durationMs: parsed.durationMs,
      timeoutAction: action,
    });
    if (!sent) {
      setError('Not connected, so the change was not sent. Try again.');
      setNote('');
      return;
    }
    setError('');
    setNote('Turn timer saved. It applies from the next turn opened.');
  }

  const errorId = `${id}-error`;
  const currentId = `${id}-current`;

  return (
    <section
      aria-labelledby={`${id}-heading`}
      className="host-controls turn-timer"
    >
      <h2 id={`${id}-heading`}>Turn timer</h2>
      <p id={currentId}>
        Current setting:{' '}
        <strong>{describeTurnTimer(turnTimerMs, turnTimeoutAction)}</strong>
      </p>
      <form onSubmit={save} noValidate className="host-timer">
        <div>
          <input
            id={`${id}-off`}
            type="checkbox"
            checked={off}
            onChange={(e) => setOff(e.target.checked)}
          />{' '}
          <label htmlFor={`${id}-off`}>Turn timer off</label>
        </div>
        <label htmlFor={`${id}-seconds`}>
          Turn timer in seconds ({TURN_TIMER_MIN_S} to {TURN_TIMER_MAX_S})
        </label>
        <input
          id={`${id}-seconds`}
          type="number"
          inputMode="numeric"
          step={1}
          min={TURN_TIMER_MIN_S}
          max={TURN_TIMER_MAX_S}
          value={seconds}
          disabled={off}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${errorId} ${currentId}` : currentId}
          onChange={(e) => setSeconds(e.target.value)}
        />
        <fieldset>
          <legend>When the timer runs out</legend>
          <div>
            <input
              id={`${id}-dodge`}
              type="radio"
              name={`${id}-action`}
              value="dodge"
              checked={action === 'dodge'}
              onChange={() => setAction('dodge')}
            />{' '}
            <label htmlFor={`${id}-dodge`}>Dodge</label>
          </div>
          <div>
            <input
              id={`${id}-hold`}
              type="radio"
              name={`${id}-action`}
              value="hold"
              checked={action === 'hold'}
              onChange={() => setAction('hold')}
            />{' '}
            <label htmlFor={`${id}-hold`}>Hold</label>
          </div>
        </fieldset>
        <button type="submit" disabled={!connected}>
          Save turn timer
        </button>
      </form>
      <p id={errorId} role={error ? 'alert' : undefined}>
        {error}
      </p>
      <p role="status" aria-live="polite">
        {error ? '' : note}
      </p>
    </section>
  );
}
