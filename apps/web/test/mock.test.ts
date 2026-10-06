// @vitest-environment node
import { afterAll, beforeAll, expect, test } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import WebSocket from 'ws';
import {
  LoginOutputSchema,
  MeOutputSchema,
  ServerMessageSchema,
  SignupOutputSchema,
} from '@game/schema';
import { createMock } from '../mock/server.js';

let server: Server;
let base: string;
beforeAll(async () => {
  server = createMock({ scriptedFlipMs: 0 });
  await new Promise<void>((r) => server.listen(0, r));
  base = `127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => void server.close());

const post = (path: string, body: unknown, cookie = '', method = 'POST') =>
  fetch(`http://${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', cookie },
    body:
      method === 'GET' || method === 'DELETE'
        ? undefined
        : JSON.stringify(body),
  });
const signup = async (
  email: string,
  name: string,
  birthdate = '1990-01-01',
) => {
  const res = await post('/api/signup', {
    email,
    password: 'correct-horse-battery',
    displayName: name,
    birthdate,
  });
  return { res, cookie: res.headers.get('set-cookie')?.split(';')[0] ?? '' };
};

test('signup, me, login responses validate against @game/schema', async () => {
  const { res, cookie } = await signup('a@example.com', 'Ann');
  expect(res.status).toBe(201);
  SignupOutputSchema.parse(await res.json());
  MeOutputSchema.parse(
    await (await post('/api/me', null, cookie, 'GET')).json(),
  );
  const l = await post('/api/login', {
    email: 'a@example.com',
    password: 'correct-horse-battery',
  });
  LoginOutputSchema.parse(await l.json());
});

test('under-18 birthdate is refused with {code,message} and no session', async () => {
  const y = new Date().getUTCFullYear() - 10;
  const { res, cookie } = await signup('kid@example.com', 'Kid', `${y}-01-01`);
  expect(res.status).toBe(403);
  expect(await res.json()).toEqual({
    code: 'UNDERAGE',
    message: expect.any(String),
  });
  expect(cookie).toBe('');
});

test('export and delete', async () => {
  const { cookie } = await signup('del@example.com', 'Del');
  expect((await post('/api/me/export', null, cookie, 'GET')).status).toBe(404);
  expect((await post('/api/me/export', null, cookie)).status).toBe(202);
  const del = (body: unknown) =>
    fetch(`http://${base}/api/me`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify(body),
    });
  expect((await del({ password: 'x', confirmation: 'nope' })).status).toBe(400);
  expect(
    (
      await del({
        password: 'wrong-password',
        confirmation: 'DELETE MY ACCOUNT',
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await del({
        password: 'correct-horse-battery',
        confirmation: 'DELETE MY ACCOUNT',
      })
    ).status,
  ).toBe(200);
  expect((await post('/api/me', null, cookie, 'GET')).status).toBe(401);
});

async function connect(cookie: string) {
  const { ticket } = (await (
    await post('/api/ws-ticket', {}, cookie)
  ).json()) as { ticket: string };
  const ws = new WebSocket(`ws://${base}/ws?ticket=${ticket}`);
  const msgs: ReturnType<typeof ServerMessageSchema.parse>[] = [];
  ws.on('message', (d) =>
    msgs.push(ServerMessageSchema.parse(JSON.parse(String(d)))),
  );
  await new Promise((r) => ws.once('open', r));
  return { ws, msgs, ticket };
}
const until = async (f: () => boolean) => {
  for (let i = 0; i < 100 && !f(); i++)
    await new Promise((r) => setTimeout(r, 10));
  expect(f()).toBe(true);
};

test('two connections see each other presence; ticket is single use', async () => {
  const a = await signup('p1@example.com', 'P1');
  const b = await signup('p2@example.com', 'P2');
  const c1 = await connect(a.cookie);
  await until(() => c1.msgs.some((m) => m.type === 'StateSync'));
  const c2 = await connect(b.cookie);
  await until(
    () =>
      c1.msgs.some(
        (m) => m.type === 'PresenceChanged' && m.payload.presence === 'online',
      ) &&
      c2.msgs.some(
        (m) =>
          m.type === 'StateSync' &&
          m.payload.state.seats.some(
            (s) => s.displayName === 'P1' && s.presence === 'online',
          ),
      ),
  );
  const sync = c2.msgs.find((m) => m.type === 'StateSync');
  expect(
    sync?.type === 'StateSync' &&
      sync.payload.state.seats.some((s) => s.displayName === 'Scripted Sam'),
  ).toBe(true);
  c2.ws.close();
  await until(() =>
    c1.msgs.some(
      (m) => m.type === 'PresenceChanged' && m.payload.presence === 'offline',
    ),
  );
  const reuse = new WebSocket(`ws://${base}/ws?ticket=${c1.ticket}`);
  await new Promise<void>((r) => reuse.on('error', () => r()));
  c1.ws.close();
});
