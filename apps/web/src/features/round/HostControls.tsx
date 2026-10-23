import { useState, type FormEvent } from 'react';
import type { RoomState } from '@game/schema';
import type { RoomSend } from './RoundPanel';
import './round.css';

/** Host turn-timer bounds agreed for M4 (Atlas decision): 30 s floor, 600 s cap. */
export const ROUND_TIMER_MIN_S = 30;
export const ROUND_TIMER_MAX_S = 600;

/**
 * Clamps a host-entered timer to the 30–600 s bounds (client-side until the server enforces them).
 * Returns the seconds to send; `null` input means no deadline and is handled by the caller.
 */
export function clampTimerSeconds(seconds: number): number {
  return Math.min(
    ROUND_TIMER_MAX_S,
    Math.max(ROUND_TIMER_MIN_S, Math.round(seconds)),
  );
}

/**
 * Host-only controls the server does not expose yet (M4-3b, Forge). The disabled buttons
 * carry the intended command so wiring is a small diff: swap `disabled` for an onClick that
 * calls `send(command, payload)`. These command names are not in the schema yet.
 */
const UNAVAILABLE: { label: string; command: string }[] = [
  { label: 'Remove a player', command: 'KickSeat' }, // payload: { seatId }
  { label: 'Transfer host', command: 'TransferHost' }, // payload: { seatId }
  { label: 'Approve late joiner', command: 'ApproveLateJoin' }, // payload: { requestId }
  { label: 'Deny late joiner', command: 'DenyLateJoin' }, // payload: { requestId }
  { label: 'End the table', command: 'EndTable' }, // payload: {}
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
    if (noLimit) {
      sendHost(
        'ConfigureRoundTimer',
        { durationMs: null },
        'Round timer saved. It applies to rounds opened after this one.',
      );
      return;
    }
    const entered = Number(seconds.trim());
    if (seconds.trim() === '' || !Number.isFinite(entered)) {
      setError('Enter a number of seconds, or choose no time limit.');
      setNote('');
      return;
    }
    const clamped = clampTimerSeconds(entered);
    sendHost(
      'ConfigureRoundTimer',
      { durationMs: clamped * 1000 },
      clamped === entered
        ? 'Round timer saved. It applies to rounds opened after this one.'
        : `Round timer saved as ${clamped} seconds, the nearest allowed value. It applies to rounds opened after this one.`,
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
        {UNAVAILABLE.map(({ label, command }) => (
          <li key={label}>
            <button type="button" disabled data-command={command}>
              {label}
            </button>{' '}
            <span>Server support is not in place yet.</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
