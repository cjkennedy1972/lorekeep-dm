import { RoomStateSchema, type RoomState, type Seat } from '@game/schema';
import type { StoredEvent } from '../persistence/index.js';

export function emptyRoom(sessionId: string): RoomState {
  return RoomStateSchema.parse({ sessionId, phase: 'lobby', seats: [] });
}

export function reduceRoom(state: RoomState, event: StoredEvent): RoomState {
  if (event.type === 'SeatJoined') {
    const seat = event.payload as Seat;
    if (state.seats.some((item) => item.accountId === seat.accountId))
      return state;
    return RoomStateSchema.parse({ ...state, seats: [...state.seats, seat] });
  }
  if (event.type === 'GameStateCommitted') {
    const payload = event.payload as { gameState: unknown };
    return RoomStateSchema.parse({ ...state, gameState: payload.gameState });
  }
  if (event.type === 'ClarificationClosed') {
    const { actionId } = event.payload as { actionId: string };
    const openClarifications = { ...state.openClarifications };
    delete openClarifications[actionId];
    return RoomStateSchema.parse({ ...state, openClarifications });
  }
  if (event.type === 'PresenceChanged') {
    const payload = event.payload as {
      seatId: string;
      presence: Seat['presence'];
    };
    return RoomStateSchema.parse({
      ...state,
      seats: state.seats.map((seat) =>
        seat.seatId === payload.seatId
          ? { ...seat, presence: payload.presence }
          : seat,
      ),
    });
  }
  return state;
}
