/**
 * The DM applied only part of a player's action. It is an alert because the player must know their
 * action did not fully land, and it stays until dismissed. No retry is offered: the rest of the turn
 * may already have succeeded, so resending would repeat it.
 */
export function PartialFailureBanner({
  message,
  onDismiss,
}: {
  message: string;
  onDismiss: () => void;
}) {
  return (
    <div className="partial-failure" role="alert">
      <p>{message}</p>
      <button type="button" onClick={onDismiss}>
        Dismiss
      </button>
    </div>
  );
}
