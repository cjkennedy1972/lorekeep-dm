import { ServerMessageSchema, type ClientEnvelope } from '@game/schema';
import { initialRoomView, roomReducer, type RoomView } from './reducer.js';

export type ConnectionStatus =
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'closed';

/** Why this seat lost the table: the host removed it, or the host ended the table. */
export type Removal = 'kicked' | 'ended';

export interface RoomSnapshot extends RoomView {
  status: ConnectionStatus;
  /** Last schema/server error, for display; never throws. */
  error: string | null;
  /** Set when the server closes this socket for a host action; the client then stops reconnecting and sending. */
  removed: Removal | null;
  /** Set when the server reports this account has no seat; the client stops and waits for a manual rejoin. */
  unseated: boolean;
}

// ponytail: Room.ts kickSeat/endTable close with these exact code+reason pairs; the kick pair is the only host-removal signal.
// 'Player is not seated at this table' also fires for self-leave during a reconnect, so it is not a removal.
export function removalForClose(code: number, reason: string): Removal | null {
  if (code === 1008 && reason === 'Seat revoked by the host') return 'kicked';
  if (code === 1000 && reason === 'Table ended by host') return 'ended';
  return null;
}

const UNSEATED_REASON = 'Player is not seated at this table';

export interface RoomClientOptions {
  /** HTTP origin of the API, e.g. http://localhost:8787 */
  baseUrl: string;
  /** Session whose single-use resume token is being rotated. */
  sessionId?: string;
  fetchImpl?: typeof fetch;
  WebSocketImpl?: typeof WebSocket;
  baseDelayMs?: number;
  maxDelayMs?: number;
  onMessage?: (message: import('@game/schema').ServerMessage) => void;
}

const initial: RoomSnapshot = {
  ...initialRoomView,
  status: 'closed',
  error: null,
  removed: null,
  unseated: false,
};

export function createRoomClient(opts: RoomClientOptions) {
  const doFetch = opts.fetchImpl ?? ((...a) => fetch(...a));
  const WS = opts.WebSocketImpl ?? WebSocket;
  const base = opts.baseDelayMs ?? 500;
  const max = opts.maxDelayMs ?? 10_000;
  let snap = initial;
  let socket: WebSocket | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;
  let generation = 0;
  let resumeToken: string | undefined;
  let pendingClaimId: string | undefined;
  let authenticatedSeatId: string | undefined;
  try {
    resumeToken =
      globalThis.localStorage?.getItem(
        `lorekeep.seat-resume-token:${opts.sessionId ?? 'default'}`,
      ) ?? undefined;
  } catch {
    /* Browser storage may be disabled; a fresh seat claim will be required. */
  }
  let stopped = true;
  const listeners = new Set<() => void>();
  const set = (p: Partial<RoomSnapshot>) => {
    snap = { ...snap, ...p };
    listeners.forEach((l) => l());
  };

  /** Returns the wire actionId so callers can match their own submission in round state, or false when offline. */
  const send = (type: string, payload: Record<string, unknown> = {}) => {
    if (snap.removed || socket?.readyState !== WS.OPEN) return false;
    const actionId = crypto.randomUUID() as ClientEnvelope['actionId'];
    const env: ClientEnvelope = {
      actionId,
      type,
      payload,
      lastSeq: snap.lastSeq,
    };
    socket.send(JSON.stringify(env));
    return actionId;
  };

  const onMessage = (data: unknown) => {
    let json: unknown;
    try {
      json = JSON.parse(String(data));
    } catch {
      return set({ error: 'Received malformed message from server.' });
    }
    const parsed = ServerMessageSchema.safeParse(json);
    if (!parsed.success)
      return set({ error: 'Received unrecognised message from server.' });
    const msg = parsed.data;
    if (msg.type === 'SeatResumeChallenge') {
      const env: ClientEnvelope = {
        actionId: crypto.randomUUID() as ClientEnvelope['actionId'],
        type: 'ResumeSeat',
        payload: resumeToken ? { resumeToken } : {},
        lastSeq: snap.lastSeq,
      };
      if (socket?.readyState === WS.OPEN) socket.send(JSON.stringify(env));
      return;
    }
    if (msg.type === 'SeatAuthenticated') {
      if (typeof msg.payload.seatId === 'string')
        authenticatedSeatId = msg.payload.seatId;
      const nextToken = msg.payload.resumeToken;
      if (typeof nextToken === 'string') {
        resumeToken = nextToken;
        try {
          globalThis.localStorage?.setItem(
            `lorekeep.seat-resume-token:${opts.sessionId ?? 'default'}`,
            resumeToken,
          );
        } catch {
          /* The current socket remains authenticated; a future new device needs host approval. */
        }
      }
      attempt = 0;
      set({ status: 'connected', error: null });
      return;
    }
    if (msg.type === 'SeatClaimPending') {
      pendingClaimId = String(msg.payload.claimId ?? '');
      set({ error: 'Waiting for the host to approve this device.' });
    }
    if (
      (msg.type === 'SeatClaimDenied' || msg.type === 'SeatClaimExpired') &&
      String(msg.payload.claimId ?? '') === pendingClaimId
    ) {
      stopped = true;
      pendingClaimId = undefined;
      resumeToken = undefined;
      try {
        globalThis.localStorage?.removeItem(
          `lorekeep.seat-resume-token:${opts.sessionId ?? 'default'}`,
        );
      } catch {
        /* The denied claim is closed even if browser storage is unavailable. */
      }
      set({
        status: 'closed',
        error: 'The host did not approve this device claim.',
      });
      socket?.close();
      return;
    }
    opts.onMessage?.(msg);
    const wasResync = snap.needsResync;
    const next = roomReducer(snap, msg);
    if (
      msg.type === 'StateSync' &&
      authenticatedSeatId &&
      !next.room?.seats.some((seat) => seat.seatId === authenticatedSeatId)
    ) {
      resumeToken = undefined;
      try {
        globalThis.localStorage?.removeItem(
          `lorekeep.seat-resume-token:${opts.sessionId ?? 'default'}`,
        );
      } catch {
        /* Revocation is enforced by the server even when storage is unavailable. */
      }
      stopped = true;
      socket?.close();
    }
    set({
      ...next,
      error: msg.type === 'Error' ? msg.payload.message : snap.error,
    });
    if (msg.type === 'StateSync') send('StateSyncAck', { seq: msg.seq });
    if (next.needsResync && !wasResync) send('Resync');
  };

  const isActive = (connectionGeneration: number) =>
    !stopped && connectionGeneration === generation;

  const scheduleReconnect = (connectionGeneration: number) => {
    if (!isActive(connectionGeneration)) return;
    set({ status: 'reconnecting' });
    const delay = Math.min(max, base * 2 ** attempt++);
    timer = setTimeout(() => void connect(connectionGeneration), delay);
  };

  async function connect(connectionGeneration: number) {
    if (!isActive(connectionGeneration)) return;
    try {
      const res = await doFetch(`${opts.baseUrl}/api/ws-ticket`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
        }),
      });
      if (!isActive(connectionGeneration)) return;
      if (!res.ok) throw new Error(`ticket ${res.status}`);
      const { ticket } = (await res.json()) as { ticket: string };
      if (!isActive(connectionGeneration)) return;
      const url = new URL('/ws', opts.baseUrl);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      url.searchParams.set('ticket', ticket);
      const ws = new WS(url.href);
      socket = ws;
      ws.onopen = () => {
        set({ status: 'connecting' });
      };
      ws.onmessage = (e) => onMessage(e.data);
      ws.onclose = (e) => {
        if (socket !== ws) return;
        const removed = removalForClose(e.code, e.reason);
        const unseated = e.code === 1008 && e.reason === UNSEATED_REASON;
        if (removed) resumeToken = undefined;
        if (removed || unseated) {
          try {
            globalThis.localStorage?.removeItem(
              `lorekeep.seat-resume-token:${opts.sessionId ?? 'default'}`,
            );
          } catch {
            /* The server enforces seat membership if storage is unavailable. */
          }
        }
        if (removed) {
          // A host kick or table end is final: do not reconnect.
          socket = undefined;
          set({ status: 'closed', removed });
          return;
        }
        if (e.code === 1008 && e.reason === UNSEATED_REASON) {
          // Not a removal: stop without retrying; start() rejoins on the user's action.
          socket = undefined;
          stopped = true;
          set({ status: 'closed', unseated: true });
          return;
        }
        scheduleReconnect(connectionGeneration);
      };
      ws.onerror = () => {};
    } catch {
      scheduleReconnect(connectionGeneration);
    }
  }

  return {
    subscribe(l: () => void) {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    getSnapshot: () => snap,
    send,
    start() {
      if (!stopped) return;
      stopped = false;
      generation++;
      attempt = 0;
      set({ status: 'connecting', unseated: false });
      void connect(generation);
    },
    stop() {
      stopped = true;
      generation++;
      clearTimeout(timer);
      const s = socket;
      socket = undefined;
      s?.close();
      set({ status: 'closed' });
    },
  };
}
export type RoomClient = ReturnType<typeof createRoomClient>;
