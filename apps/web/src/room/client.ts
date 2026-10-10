import { ServerMessageSchema, type ClientEnvelope } from '@game/schema';
import { initialRoomView, roomReducer, type RoomView } from './reducer.js';

export type ConnectionStatus =
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'closed';

export interface RoomSnapshot extends RoomView {
  status: ConnectionStatus;
  /** Last schema/server error, for display; never throws. */
  error: string | null;
}

export interface RoomClientOptions {
  /** HTTP origin of the API, e.g. http://localhost:8787 */
  baseUrl: string;
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
  let stopped = true;
  const listeners = new Set<() => void>();
  const set = (p: Partial<RoomSnapshot>) => {
    snap = { ...snap, ...p };
    listeners.forEach((l) => l());
  };

  const send = (type: string, payload: Record<string, unknown> = {}) => {
    if (socket?.readyState !== WS.OPEN) return false;
    const env: ClientEnvelope = {
      actionId: crypto.randomUUID() as ClientEnvelope['actionId'],
      type,
      payload,
      lastSeq: snap.lastSeq,
    };
    socket.send(JSON.stringify(env));
    return true;
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
      });
      if (!res.ok) throw new Error(`ticket ${res.status}`);
      const { ticket } = (await res.json()) as { ticket: string };
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
      ws.onclose = () => {
        if (socket === ws) scheduleReconnect();
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
      set({ status: 'connecting' });
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
