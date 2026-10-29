import type { DeviceClaimState } from '../../room/client';

interface Props {
  /** This socket's seat, from SeatAuthenticated; null until the device claim is approved. */
  mySeatId: string | null;
  /** The seat has a bound character, so the lobby needs no waiting copy. */
  bound: boolean;
  /** The table is mid-game, so a newly seated player joins at a round boundary. */
  inPlay: boolean;
  deviceClaim: DeviceClaimState | null;
  /** Current time in ms; the parent ticks it while a claim is pending. */
  now: number;
  /** Seconds until another ask is allowed; 0 when the button is enabled. */
  askWaitSeconds: number;
  onAskAgain: () => void;
}

/** Stages between the host's approval and the seat being bound; the bind form shows once bound. */
export function ClaimStatus({
  mySeatId,
  bound,
  inPlay,
  deviceClaim,
  now,
  askWaitSeconds,
  onAskAgain,
}: Props) {
  if (bound) return null;

  if (deviceClaim?.status === 'pending') {
    const left = Math.max(0, Math.ceil((deviceClaim.expiresAt - now) / 1000));
    return (
      <section aria-labelledby="claim-status-heading" className="panel">
        <h2 id="claim-status-heading">Joining the table</h2>
        <p role="status" aria-live="polite">
          Approved by the host. Waiting for the host to confirm your device.
        </p>
        <p>
          The host has {left} {left === 1 ? 'second' : 'seconds'} to confirm.
        </p>
      </section>
    );
  }

  if (deviceClaim) {
    const timedOut = deviceClaim.status === 'expired';
    return (
      <section aria-labelledby="claim-status-heading" className="panel">
        <h2 id="claim-status-heading">Joining the table</h2>
        <p role="alert">
          {timedOut
            ? 'That request timed out. The host did not confirm your device in time.'
            : 'The host did not confirm your device.'}
        </p>
        <div className="actions">
          <button
            type="button"
            onClick={onAskAgain}
            disabled={askWaitSeconds > 0}
            aria-describedby={askWaitSeconds > 0 ? 'ask-again-wait' : undefined}
          >
            Ask again
          </button>
        </div>
        {askWaitSeconds > 0 && (
          <p id="ask-again-wait" role="status">
            You can ask again in {askWaitSeconds}{' '}
            {askWaitSeconds === 1 ? 'second' : 'seconds'}.
          </p>
        )}
      </section>
    );
  }

  if (mySeatId !== null && inPlay) {
    return (
      <section aria-labelledby="claim-status-heading" className="panel">
        <h2 id="claim-status-heading">Joining the table</h2>
        <p role="status" aria-live="polite">
          You are in. Joining at the start of the next round.
        </p>
      </section>
    );
  }

  return null;
}
