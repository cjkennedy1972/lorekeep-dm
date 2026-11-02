import { useEffect, useState } from 'react';
import type { ConnectionStatus as Status } from './client.js';

/**
 * A reconnect shorter than this is a blip, such as a server-side socket close during combat that reconnects
 * within a second. The header line already says "Reconnecting…", so the notice waits and does not flash over the story.
 */
export const RECONNECT_NOTICE_DELAY_MS = 2_000;

/**
 * Shown after the client has stopped retrying a seat that the server keeps refusing. The player decides when to
 * try again; the copy names no record and no reason beyond what they can act on.
 */
export function ReconnectGaveUpNotice({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="table-connection-notice">
      <p>
        We couldn’t reconnect you to the table. Check your network connection,
        then select Retry.
      </p>
      <button type="button" onClick={onRetry}>
        Retry
      </button>
    </div>
  );
}

/**
 * Shown only while a reconnect has lasted. A closed seat is not shown here: it is not reconnecting, and
 * a removed or unseated seat never will, so it gets its own message elsewhere. A reconnect that gave up
 * is shown regardless of status, because it stays closed until the player retries.
 * During combat a lasting reconnect names the server outage and says the encounter is held, so the player
 * knows their place in the turn order survives the wait.
 */
export function TableConnectionNotice({
  status,
  reconnectGaveUp = false,
  inCombat = false,
  onRetry,
}: {
  status: Status;
  reconnectGaveUp?: boolean;
  inCombat?: boolean;
  onRetry?: () => void;
}) {
  const [lasting, setLasting] = useState(false);
  useEffect(() => {
    setLasting(false);
    if (status !== 'reconnecting') return;
    const timer = setTimeout(() => setLasting(true), RECONNECT_NOTICE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [status]);
  // The live region stays mounted so a lasting reconnect is announced politely, without interrupting as an alert.
  return (
    <div role="status" aria-live="polite">
      {reconnectGaveUp && onRetry ? (
        <ReconnectGaveUpNotice onRetry={onRetry} />
      ) : (
        status === 'reconnecting' &&
        lasting &&
        (inCombat ? (
          <p className="table-connection-notice">
            The server is unavailable, so combat is paused. Your place in the
            turn order is kept. Reconnecting…
          </p>
        ) : (
          <p className="table-connection-notice">
            Connection to the table lost. Reconnecting… Your game is safe, and
            actions can be sent once it reconnects.
          </p>
        ))
      )}
    </div>
  );
}
