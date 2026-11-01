export type PendingInput = {
  id: string;
  text: string;
  acknowledged: boolean;
  submittedAt: number;
};

/**
 * Local pending state wins while it exists. After a reload it is gone, so the
 * server's private round submission seeds the input; the wait timer starts at
 * the server's original submittedAt timestamp so the wait timer survives reloads.
 */
export function pendingInputFor(
  local: PendingInput | null,
  submission:
    | { actionId: string; text: string; submittedAt?: number }
    | undefined,
  seenAt: number,
): PendingInput | null {
  if (local) return local;
  if (!submission) return null;
  return {
    id: submission.actionId,
    text: submission.text,
    acknowledged: true,
    submittedAt: submission.submittedAt ?? seenAt,
  };
}
