import { render, type RenderResult } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { afterAll, beforeAll } from 'vitest';
import { App } from '../src/App';
import { http } from '../src/api';
import { AuthProvider } from '../src/auth';
import { createMock } from '../mock/server';

/** Boots the mock on an ephemeral port; callers read the URL from `mock.url`. */
export const mock = { url: '' };
export function useMockServer() {
  let server: Server;
  beforeAll(async () => {
    server = createMock({ scriptedFlipMs: 0 });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    http.base =
      mock.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => void server.close());
}

/** A fetch with its own cookie jar, standing in for one browser profile. */
export function jarFetch(): typeof fetch {
  let cookie = '';
  return async (input, init) => {
    const res = await fetch(input, {
      ...init,
      headers: { ...(init?.headers as object), cookie },
    });
    const set = res.headers.get('set-cookie')?.split(';')[0];
    if (set) cookie = set.endsWith('=') ? '' : set;
    return res;
  };
}

/** Installs a fresh signed-out profile as the app's fetch. */
export function useJar() {
  const f = jarFetch();
  http.fetch = f;
  http.WebSocket = WebSocket as unknown as typeof globalThis.WebSocket;
  return f;
}

export const renderApp = (path: string): RenderResult =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </MemoryRouter>,
  );

/** Signs up through the API on the current profile (leaves it signed in). */
export async function seedAccount(email: string, name: string) {
  const r = await http.fetch(`${http.base}/api/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email,
      password: 'correct-horse-battery',
      displayName: name,
      birthdate: '1990-01-01',
    }),
  });
  if (!r.ok) throw new Error('seed failed');
}
