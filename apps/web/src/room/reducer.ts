import type { RoomState, ServerMessage } from '@game/schema';

export interface RoomView {
  room: RoomState | null;
  lastSeq: number;
  /** True when a seq gap was seen; the client must send a resync request. */
  needsResync: boolean;
}

export const initialRoomView: RoomView = {
  room: null,
  lastSeq: 0,
  needsResync: false,
};

/** Pure reducer: StateSync replaces; sequenced patches apply only when seq === lastSeq + 1. */
export function roomReducer(view: RoomView, msg: ServerMessage): RoomView {
  switch (msg.type) {
    case 'StateSync':
      if (msg.seq <= view.lastSeq && view.room) return view; // duplicate/stale snapshot
      return { room: msg.payload.state, lastSeq: msg.seq, needsResync: false };
    case 'PresenceChanged': {
      if (msg.seq <= view.lastSeq) return view; // duplicate or out-of-order
      if (!view.room || msg.seq !== view.lastSeq + 1)
        return view.needsResync ? view : { ...view, needsResync: true };
      const { seatId, presence } = msg.payload;
      return {
        ...view,
        lastSeq: msg.seq,
        room: {
          ...view.room,
          seats: view.room.seats.map((s) =>
            s.seatId === seatId ? { ...s, presence } : s,
          ),
        },
      };
    }
    case 'Error':
      return view; // surfaced by the client, not part of room state
  }
}
