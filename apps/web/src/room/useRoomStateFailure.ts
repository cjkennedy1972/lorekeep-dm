import { useEffect, useState } from 'react';
import type { ConnectionStatus } from './client.js';

/** How long a live table may stay connected without delivering its room state. Same schedule as the sheet (#423). */
export const ROOM_STATE_TIMEOUT_MS = 10_000;
/**
 * A closed socket is a terminal signal for this screen, but the client starts as
 * `closed` before its first connect, so wait briefly before treating it as failed.
 */
export const ROOM_CLOSED_GRACE_MS = 2_000;

/**
 * True once the table has waited too long for room state. Any status change, or a
 * new `attempt` from a retry, restarts the wait so a retry always gets a fresh chance,
 * including when the status was already `connecting`.
 */
export function useRoomStateFailure({
  hasRoom,
  connectionStatus,
  attempt = 0,
}: {
  hasRoom: boolean;
  connectionStatus: ConnectionStatus;
  attempt?: number;
}): boolean {
  const [stalled, setStalled] = useState(false);

  useEffect(() => {
    setStalled(false);
    if (hasRoom) return;
    const delay =
      connectionStatus === 'closed'
        ? ROOM_CLOSED_GRACE_MS
        : ROOM_STATE_TIMEOUT_MS;
    const timer = setTimeout(() => setStalled(true), delay);
    return () => clearTimeout(timer);
  }, [hasRoom, connectionStatus, attempt]);

  return !hasRoom && stalled;
}
