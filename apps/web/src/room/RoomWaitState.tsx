import { Link } from 'react-router-dom';
import type { ConnectionStatus as Status } from './client.js';
import { ConnectionStatus } from './ConnectionStatus.js';

export interface RoomWaitStateProps {
  status: Status;
  /** Server-side error for this room, if any. */
  error?: string | null;
  /** True once the table has waited past its timeout without room state. */
  stalled: boolean;
  /** Where to send the player when the table will not come up. */
  lobbyHref: string;
  /** Omit when a retry is unavailable (for example, after a host removal). */
  onRetry?: () => void;
}

/**
 * Shown while the live table has not delivered room state. The waiting status is
 * polite and spinner-based (the spinner stops under reduced motion); once stalled,
 * the alert announces the problem and offers a retry and a way back to the lobby.
 */
export function RoomWaitState({
  status,
  error,
  stalled,
  lobbyHref,
  onRetry,
}: RoomWaitStateProps) {
  return (
    <section className="game-notice">
      <h1>Game</h1>
      <ConnectionStatus status={status} />
      {error && <p role="alert">{error}</p>}
      {stalled ? (
        <>
          <p role="alert">
            The table hasn’t answered yet. Give it another try, or head back to
            the lobby.
          </p>
          <p>
            {onRetry && (
              <button type="button" onClick={onRetry}>
                Try again
              </button>
            )}{' '}
            <Link to={lobbyHref}>Back to the lobby</Link>
          </p>
        </>
      ) : (
        <>
          <p role="status" className="loading">
            <span className="spinner" aria-hidden="true" />
            Waiting for room state…
          </p>
          <div className="skeleton" aria-hidden="true" />
        </>
      )}
    </section>
  );
}
