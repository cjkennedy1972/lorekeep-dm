import { useState, type FormEvent } from 'react';
import type { RoomState } from '@game/schema';
import type { RoomSend } from './RoundPanel';
import './round.css';

/** Host turn-timer bounds agreed for M4 (Atlas decision): 30 s floor, 600 s cap. */
export const ROUND_TIMER_MIN_S = 30;
export const ROUND_TIMER_MAX_S = 600;

/** Validates a host-entered timer in seconds; null means no deadline. */
export function timerMsFromSeconds(
  seconds: number | null,
): { ok: true; durationMs: number | null } | { ok: false; message: string } {
  if (seconds === null) return { ok: true, durationMs: null };
  if (
    !Number.isInteger(seconds) ||
    seconds < ROUND_TIMER_MIN_S ||
    seconds > ROUND_TIMER_MAX_S
  ) {
    return {
      ok: false,
      message: `Enter a whole number of seconds from ${ROUND_TIMER_MIN_S} to ${ROUND_TIMER_MAX_S}, or choose no time limit.`,
    };
  }
  return { ok: true, durationMs: seconds * 1000 };
}

/** Host-only controls the server already supports, plus the ones it does not yet expose. */
const UNAVAILABLE = [
  'Remove a player',
  'Transfer host',
  'Approve or deny late joiners',
  'End the table',
];

type Props = {
  round: RoomState['round'];
  roundDurationMs: RoomState['roundDurationMs'];
  connected: boolean;
  send: RoomSend;
};

export function HostControls({
  round,
  roundDurationMs,
  connected,
  send,
}: Props) {
  const [noLimit, setNoLimit] = useState(roundDurationMs === null);
  const [seconds, setSeconds] = useState(
    roundDurationMs ? String(roundDurationMs / 1000) : '',
  );
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const canResolve = connected && round?.status === 'open';

  function sendHost(
    type: string,
    payload: Record<string, unknown>,
    done: string,
  ) {
    if (!send(type, payload)) {
      setError('Not connected, so the change was not sent. Try again.');
      setNote('');
      return;
    }
    setError('');
    setNote(done);
  }

  function saveTimer(e: FormEvent) {
    e.preventDefault();
    const parsed = timerMsFromSeconds(noLimit ? null : Number(seconds.trim()));
    if (!parsed.ok) {
      setError(parsed.message);
      setNote('');
      return;
    }
    sendHost(
      'ConfigureRoundTimer',
      { durationMs: parsed.durationMs },
      'Round timer saved. It applies to rounds opened after this one.',
    );
  }

  return (
    <section aria-labelledby="host-heading" className="host-controls">
      <h2 id="host-heading">Host controls</h2>
      <div className="actions">
        <button
          type="button"
          disabled={!canResolve}
          onClick={() => sendHost('ResolveNow', {}, 'Round resolve requested.')}
        >
          Resolve round now
        </button>
        <button
          type="button"
          disabled={!connected}
          onClick={() =>
            sendHost('RewindTurn', {}, 'Rewind requested for the last turn.')
          }
        >
          Rewind last turn
        </button>
      </div>
      <form onSubmit={saveTimer} noValidate className="host-timer">
        <div>
          <input
            id="host-round-timer-none"
            type="checkbox"
            checked={noLimit}
            onChange={(e) => setNoLimit(e.target.checked)}
          />{' '}
          <label htmlFor="host-round-timer-none">No time limit</label>
        </div>
        <label htmlFor="host-round-timer">
          Round timer in seconds ({ROUND_TIMER_MIN_S} to {ROUND_TIMER_MAX_S})
        </label>
        <input
          id="host-round-timer"
          type="number"
          inputMode="numeric"
          min={ROUND_TIMER_MIN_S}
          max={ROUND_TIMER_MAX_S}
          value={seconds}
          disabled={noLimit}
          onChange={(e) => setSeconds(e.target.value)}
        />
        <button type="submit" disabled={!connected}>
          Save round timer
        </button>
      </form>
      <p role={error ? 'alert' : 'status'} aria-live="polite">
        {error || note}
      </p>
      <h3 id="host-unavailable-heading">Not available yet</h3>
      <ul
        aria-labelledby="host-unavailable-heading"
        className="host-unavailable"
      >
        {UNAVAILABLE.map((label) => (
          <li key={label}>
            <button type="button" disabled>
              {label}
            </button>{' '}
            <span>Server support is not in place yet.</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
