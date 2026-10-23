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
  let resumeToken: string | undefined;
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
    opts.onMessage?.(msg);
    const wasResync = snap.needsResync;
    const next = roomReducer(snap, msg);
    set({
      ...next,
      error: msg.type === 'Error' ? msg.payload.message : snap.error,
    });
    if (next.needsResync && !wasResync) send('Resync');
  };

  const scheduleReconnect = () => {
    if (stopped) return;
    set({ status: 'reconnecting' });
    const delay = Math.min(max, base * 2 ** attempt++);
    timer = setTimeout(connect, delay);
  };

  async function connect() {
    if (stopped) return;
    try {
      const res = await doFetch(`${opts.baseUrl}/api/ws-ticket`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
          ...(resumeToken ? { resumeToken } : {}),
        }),
      });
      if (!res.ok) throw new Error(`ticket ${res.status}`);
      const body = (await res.json()) as {
        ticket: string;
        resumeToken?: string;
      };
      const { ticket } = body;
      if (body.resumeToken) {
        resumeToken = body.resumeToken;
        try {
          globalThis.localStorage?.setItem(
            `lorekeep.seat-resume-token:${opts.sessionId ?? 'default'}`,
            resumeToken,
          );
        } catch {
          /* Best-effort persistence. */
        }
      }
      if (stopped) return;
      const url = new URL('/ws', opts.baseUrl);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      url.searchParams.set('ticket', ticket);
      const ws = new WS(url.href);
      socket = ws;
      ws.onopen = () => {
        attempt = 0;
        set({ status: 'connected', error: null });
        // Server sends StateSync on join; lastSeq in envelopes lets it resume.
      };
      ws.onmessage = (e) => onMessage(e.data);
      ws.onclose = (e) => {
        if (socket !== ws) return;
        const removed = removalForClose(e.code, e.reason);
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
        scheduleReconnect();
      };
      ws.onerror = () => {};
    } catch {
      scheduleReconnect();
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
      attempt = 0;
      set({ status: 'connecting', unseated: false });
      void connect();
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
      const s = socket;
      socket = undefined;
      s?.close();
      set({ status: 'closed' });
    },
  };
}
export type RoomClient = ReturnType<typeof createRoomClient>;
