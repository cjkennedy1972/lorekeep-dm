import { useEffect, useState } from 'react';
import type { ConnectionStatus as Status } from './client.js';

/**
 * A reconnect shorter than this is a blip, such as a server-side socket close during combat that reconnects
 * within a second. The header line already says "Reconnecting…", so the notice waits and does not flash over the story.
 */
export const RECONNECT_NOTICE_DELAY_MS = 2_000;

/**
 * Shown only while a reconnect has lasted. A closed seat is not shown here: it is not reconnecting, and
 * a removed or unseated seat never will, so it gets its own message elsewhere.
 */
export function TableConnectionNotice({ status }: { status: Status }) {
  const [lasting, setLasting] = useState(false);
  useEffect(() => {
    setLasting(false);
    if (status !== 'reconnecting') return;
    const timer = setTimeout(() => setLasting(true), RECONNECT_NOTICE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [status]);
  if (status !== 'reconnecting' || !lasting) return null;
  return (
    <p className="table-connection-notice">
      Connection to the table lost. Reconnecting… Your game is safe, and actions
      can be sent once it reconnects.
    </p>
  );
}
