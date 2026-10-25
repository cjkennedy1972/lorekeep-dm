import { RoomStateSchema, type RoomState } from '@game/schema';
import type { LatestState } from '../persistence/index.js';
import { emptyRoom, reduceRoom } from './reducer.js';

export function recoverRoom(
  sessionId: string,
  latest: LatestState,
): { state: RoomState; seq: number; actionIds: Set<string> } {
  let state = latest.snapshot
    ? RoomStateSchema.parse(latest.snapshot.state)
    : emptyRoom(sessionId);
  if (state.sessionId !== sessionId)
    throw new Error('Snapshot session mismatch');
  let seq = latest.snapshot?.seq ?? 0;
  const saved = latest.snapshot?.state as { actionIds?: string[] } | undefined;
  const actionIds = new Set<string>(saved?.actionIds ?? []);
  for (const event of latest.events) {
    if (event.seq !== seq + 1) throw new Error('Non-contiguous room log');
    state = reduceRoom(state, event);
    if (
      [
        'ActionAccepted',
        'ActionEdited',
        'SeatRevoked',
        'HostTransferred',
        'LateJoinApproved',
        'LateJoinDenied',
        'LateJoinExpired',
        'LateJoinCancelled',
        'TableEnded',
        'ChatMuteChanged',
        'RoundTimerConfigured',
      ].includes(event.type)
    ) {
      const payload = event.payload as {
        actionId?: string;
        commandActionId?: string;
        actionIds?: string[];
        submission?: { actionId?: string; actionIds?: string[] };
      };
      for (const actionId of [
        ...(payload.actionIds ?? []),
        ...(payload.commandActionId ? [payload.commandActionId] : []),
        ...(payload.submission?.actionIds ?? []),
        ...((payload.actionId ?? payload.submission?.actionId)
          ? [(payload.actionId ?? payload.submission?.actionId) as string]
          : []),
      ])
        actionIds.add(actionId);
    }
    seq = event.seq;
  }
  return { state, seq, actionIds };
}
