import { randomUUID } from 'node:crypto';
import {
  expect,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';

export const API = 'http://localhost:8787';

export type TestRoom = { id: string; code: string };
export type Frame = { type?: string; payload?: Record<string, unknown> };

/** Signs up a fresh adult account in this browser context. */
export async function signedIn(context: BrowserContext, name: string) {
  // Host tools and party chat are collapsed drawers that remember being opened; these specs drive them.
  await context.addInitScript(() => {
    for (const id of ['host', 'chat'])
      localStorage.setItem(`lorekeep.drawer.${id}`, 'open');
  });
  const response = await context.request.post(`${API}/api/signup`, {
    data: {
      email: `round-${randomUUID()}@example.com`,
      password: 'correct-horse-battery',
      displayName: name,
      birthdate: '1990-01-01',
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
}

export async function openTable(host: BrowserContext, name: string) {
  const response = await host.request.post(`${API}/api/rooms`, {
    data: { name },
  });
  expect(response.ok()).toBe(true);
  const { room } = (await response.json()) as { room: TestRoom };
  return room;
}

/** Joins the table by invite code, then opens its game screen and waits for the socket. */
export async function enterGame(page: Page, room: TestRoom, title: string) {
  await page.goto(`/join/${room.code}`);
  await page.getByRole('button', { name: 'Join table' }).click();
  await page.getByRole('heading', { name: title }).waitFor();
  await expect(page.getByText('Connected to the room.')).toBeVisible();
  await page.goto(`/rooms/${room.id}/game`);
  await expect(page.getByText('Connected')).toBeVisible();
}

/** Records every frame the page sends over the room socket. Call before navigating. */
export function recordFrames(page: Page) {
  const frames: Frame[] = [];
  page.on('websocket', (ws) =>
    ws.on('framesent', (event) => {
      try {
        frames.push(JSON.parse(String(event.payload)));
      } catch {
        // Non-JSON frames are not part of the room protocol.
      }
    }),
  );
  return frames;
}

/** Whether a sent frame of `type` has every given payload field. */
export function sent(frames: Frame[], type: string, payload: object = {}) {
  return frames.some(
    (f) =>
      f.type === type &&
      Object.entries(payload).every(
        ([key, value]) => f.payload?.[key] === value,
      ),
  );
}

/** Drives the mock round (test-only route on the dev mock). */
export async function script(
  context: BrowserContext,
  room: TestRoom,
  body: Record<string, unknown>,
) {
  const response = await context.request.post(
    `${API}/api/test/tables/${room.id}/round`,
    { data: body },
  );
  expect(response.ok(), await response.text()).toBe(true);
}

/** A host and one guest seated at a fresh table, both on the game screen. */
export async function twoPlayerTable(browser: Browser, title: string) {
  const host = await browser.newContext();
  const guest = await browser.newContext();
  await signedIn(host, 'Round Host');
  await signedIn(guest, 'Round Guest');
  const room = await openTable(host, title);
  const hostPage = await host.newPage();
  const guestPage = await guest.newPage();
  const hostFrames = recordFrames(hostPage);
  const guestFrames = recordFrames(guestPage);
  await enterGame(hostPage, room, title);
  await enterGame(guestPage, room, title);
  return { host, guest, hostPage, guestPage, room, hostFrames, guestFrames };
}
