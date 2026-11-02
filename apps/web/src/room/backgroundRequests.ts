/**
 * Admits one outstanding request of a kind. A reply (or refusal) calls `end`. A gate whose reply never
 * arrives reopens after `ttlMs`, so a lost reply cannot block the kind forever.
 */
export function createInFlightGate(
  ttlMs: number,
  now: () => number = Date.now,
) {
  let sentAt: number | null = null;
  return {
    /** Returns true and marks the request in flight, or false while an earlier one is still outstanding. */
    begin(): boolean {
      const at = now();
      if (sentAt !== null && at - sentAt < ttlMs) return false;
      sentAt = at;
      return true;
    },
    end(): void {
      sentAt = null;
    },
  };
}

/**
 * The server refuses a background read (Resync, ChatHistoryRequest) over its sync budget with a
 * RATE_LIMITED error that names no action. Player actions always carry an actionId, so this shape
 * means nothing the seat did failed; the caller releases its gate and shows nothing.
 */
export function isBackgroundRefusal(payload: Record<string, unknown>): boolean {
  return payload.code === 'RATE_LIMITED' && !payload.actionId;
}

/**
 * The room error after a server message. An error reply to a background read is absorbed: the room keeps
 * the error it already showed, and only errors the seat's own requests caused replace it.
 */
export function roomErrorAfter(
  message: { type: string; payload?: unknown },
  previous: string | null,
): string | null {
  if (message.type !== 'Error') return previous;
  const payload = (message.payload ?? {}) as Record<string, unknown>;
  if (isBackgroundRefusal(payload)) return previous;
  return typeof payload.message === 'string' ? payload.message : previous;
}
