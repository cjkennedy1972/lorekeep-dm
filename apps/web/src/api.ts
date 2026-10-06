import type { Account } from '@game/schema';

export const API_URL: string =
  (import.meta.env.VITE_API_URL as string | undefined) ??
  'http://localhost:8787';

/** Tests swap `http.fetch` (cookie jar) and `http.base` (mock port) and `http.WebSocket` (jsdom's Event is not undici's); the app uses the platform fetch. */
export const http = {
  base: API_URL,
  WebSocket: undefined as typeof WebSocket | undefined,
  fetch: (...a: Parameters<typeof fetch>) => fetch(...a),
};

export interface RoomInfo {
  id: string;
  name: string;
  isHost: boolean;
  /** Present for the host only. */
  code?: string;
}

export type ApiResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; code: string; message: string };

export async function api<T = Record<string, never>>(
  path: string,
  body?: unknown,
  method = body === undefined ? 'GET' : 'POST',
): Promise<ApiResult<T>> {
  try {
    const res = await http.fetch(`${http.base}${path}`, {
      method,
      credentials: 'include',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    if (res.ok) return { ok: true, status: res.status, data: json as T };
    return {
      ok: false,
      status: res.status,
      code: String(json.code ?? 'ERROR'),
      message: String(json.message ?? 'Something went wrong. Try again.'),
    };
  } catch {
    return {
      ok: false,
      status: 0,
      code: 'NETWORK',
      message: 'Could not reach the server. Check your connection and retry.',
    };
  }
}

export type { Account };
