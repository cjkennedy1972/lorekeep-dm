import { useEffect, useState } from 'react';
import type { ConnectionStatus } from '../../room/client.js';

/** How long a live room may stay connected without delivering character state. */
export const SHEET_LOAD_TIMEOUT_MS = 10_000;
/**
 * A closed socket is a terminal signal for this screen, but the client starts as
 * `closed` before its first connect, so wait briefly before treating it as failed.
 */
export const SHEET_CLOSED_GRACE_MS = 2_000;

/**
 * True once the sheet has waited too long for room state to arrive. Any status
 * change restarts the wait, so a reconnect gets a fresh chance to deliver state.
 */
export function useSheetLoadFailure({
  hasCharacterState,
  connectionStatus,
}: {
  hasCharacterState: boolean;
  connectionStatus: ConnectionStatus;
}): boolean {
  const [stalled, setStalled] = useState(false);

  useEffect(() => {
    setStalled(false);
    if (hasCharacterState) return;
    const delay =
      connectionStatus === 'closed'
        ? SHEET_CLOSED_GRACE_MS
        : SHEET_LOAD_TIMEOUT_MS;
    const timer = setTimeout(() => setStalled(true), delay);
    return () => clearTimeout(timer);
  }, [hasCharacterState, connectionStatus]);

  return !hasCharacterState && stalled;
}
