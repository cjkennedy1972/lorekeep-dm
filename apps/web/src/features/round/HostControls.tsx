import { useState, type FormEvent } from 'react';
import type {
  LateJoinHostRequest,
  RoomState,
  RoundSnapshot,
  Seat,
} from '@game/schema';
import type { RoomSend } from './RoundPanel';
import { ConfirmDialog } from './ConfirmDialog';
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

type Props = {
  round: RoundSnapshot | undefined;
  roundDurationMs: RoomState['roundDurationMs'];
  connected: boolean;
  paused?: boolean;
  pauseCause?: 'host' | 'no-connected-seats';
  send: RoomSend;
  seats?: Seat[];
  /** The host's own seat, excluded from kick and transfer. */
  selfSeatId?: string;
  lateJoinRequests?: LateJoinHostRequest[];
};

type Confirming =
  | { kind: 'kick'; seat: Seat }
  | { kind: 'transfer'; seat: Seat }
  | { kind: 'end' }
  | null;

export function HostControls({
  round,
  roundDurationMs,
  connected,
  paused = false,
  pauseCause,
  send,
  seats = [],
  selfSeatId,
  lateJoinRequests = [],
}: Props) {
  const [noLimit, setNoLimit] = useState(roundDurationMs === null);
  const [seconds, setSeconds] = useState(
    roundDurationMs ? String(roundDurationMs / 1000) : '',
  );
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [confirming, setConfirming] = useState<Confirming>(null);
  const canResolve = connected && round?.status === 'open' && !paused;
  const others = seats.filter((seat) => seat.seatId !== selfSeatId);
  const pendingRequests = lateJoinRequests;

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

  function confirmAndSend() {
    if (confirming?.kind === 'kick') {
      const { seat } = confirming;
      sendHost(
        'KickSeat',
        { seatId: seat.seatId },
        `Removing ${seat.displayName} from the table.`,
      );
    } else if (confirming?.kind === 'transfer') {
      const { seat } = confirming;
      sendHost(
        'TransferHost',
        { seatId: seat.seatId },
        `${seat.displayName} is now the host.`,
      );
    } else if (confirming?.kind === 'end') {
      sendHost('EndTable', {}, 'Ending the table.');
    }
    setConfirming(null);
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
        {paused &&
          (pauseCause === 'no-connected-seats' ? (
            <span>
              Table paused: waiting for players to reconnect. It will resume
              automatically when a seat is confirmed connected.
            </span>
          ) : (
            <span>Resume the table to resolve the round.</span>
          ))}
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
      {others.length === 0 && (
        <div className="actions">
          <button type="button" disabled>
            Transfer host
          </button>
          <span>No other player can take host yet.</span>
        </div>
      )}
      {others.length > 0 && (
        <section aria-labelledby="host-seats-heading" className="host-seats">
          <h3 id="host-seats-heading">Players</h3>
          <ul>
            {others.map((seat) => (
              <li key={seat.seatId}>
                <span>{seat.displayName}</span>{' '}
                <button
                  type="button"
                  disabled={!connected}
                  onClick={() => setConfirming({ kind: 'transfer', seat })}
                >
                  Make {seat.displayName} host
                </button>{' '}
                <button
                  type="button"
                  className="danger"
                  disabled={!connected}
                  onClick={() => setConfirming({ kind: 'kick', seat })}
                >
                  Remove {seat.displayName}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {pendingRequests.length > 0 && (
        <section aria-labelledby="host-late-heading" className="host-seats">
          <h3 id="host-late-heading">Late join requests</h3>
          <ul>
            {pendingRequests.map((req) => (
              <li key={req.requestId}>
                <span>{req.displayName} wants to join.</span>{' '}
                <button
                  type="button"
                  disabled={!connected}
                  onClick={() =>
                    sendHost(
                      'ApproveLateJoin',
                      { requestId: req.requestId },
                      `Approved ${req.displayName}.`,
                    )
                  }
                >
                  Approve {req.displayName}
                </button>{' '}
                <button
                  type="button"
                  disabled={!connected}
                  onClick={() =>
                    sendHost(
                      'DenyLateJoin',
                      { requestId: req.requestId },
                      `Denied ${req.displayName}.`,
                    )
                  }
                >
                  Deny {req.displayName}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <div className="actions">
        <button
          type="button"
          className="danger"
          disabled={!connected}
          onClick={() => setConfirming({ kind: 'end' })}
        >
          End the table
        </button>
      </div>
      <p role={error ? 'alert' : 'status'} aria-live="polite">
        {error || note}
      </p>
      {confirming?.kind === 'transfer' && (
        <ConfirmDialog
          titleId="host-confirm-title"
          title={`Make ${confirming.seat.displayName} the host?`}
          confirmLabel="Make host"
          onConfirm={confirmAndSend}
          onCancel={() => setConfirming(null)}
        >
          <p>You will stop being the host and lose host controls.</p>
        </ConfirmDialog>
      )}
      {confirming?.kind === 'kick' && (
        <ConfirmDialog
          titleId="host-confirm-title"
          title={`Remove ${confirming.seat.displayName}?`}
          confirmLabel="Remove player"
          onConfirm={confirmAndSend}
          onCancel={() => setConfirming(null)}
        >
          <p>They will be disconnected from the table.</p>
        </ConfirmDialog>
      )}
      {confirming?.kind === 'end' && (
        <ConfirmDialog
          titleId="host-confirm-title"
          title="End the table for everyone?"
          confirmLabel="End table"
          onConfirm={confirmAndSend}
          onCancel={() => setConfirming(null)}
        >
          <p>
            Everyone at the table will be disconnected. This cannot be undone.
          </p>
        </ConfirmDialog>
      )}
    </section>
  );
}
