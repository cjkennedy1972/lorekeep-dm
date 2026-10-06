import type { ConnectionStatus as Status } from './client.js';

const LABEL: Record<Status, string> = {
  connecting: 'Connecting to the room…',
  connected: 'Connected to the room.',
  reconnecting: 'Connection lost. Reconnecting…',
  closed: 'Disconnected from the room.',
};

/** Polite live region: screen readers announce each status change without interrupting. */
export function ConnectionStatus({ status }: { status: Status }) {
  return (
    <p role="status" aria-live="polite" data-status={status}>
      {LABEL[status]}
    </p>
  );
}
