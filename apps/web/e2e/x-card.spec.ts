import { randomUUID } from 'node:crypto';
import { expect, test, type BrowserContext } from '@playwright/test';
import { redactInviteUrls, rethrowRedacted } from './redact';

const API = 'http://localhost:8787';

async function createTable(context: BrowserContext, name: string) {
  const response = await context.request.post(`${API}/api/rooms`, {
    data: { name, mode: 'party' },
  });
  expect(response.ok()).toBe(true);
  return (await response.json()) as {
    room: { id: string; code: string };
  };
}

async function signedIn(context: BrowserContext, name: string) {
  const response = await context.request.post(`${API}/api/signup`, {
    data: {
      email: `safety-${randomUUID()}@example.com`,
      password: 'correct-horse-battery',
      displayName: name,
      birthdate: '1990-01-01',
    },
  });
  expect(response.ok(), redactInviteUrls(await response.text())).toBe(true);
}

test('keyboard X-card is anonymous and pause is visible to every seat', async ({
  browser,
}) => {
  const host = await browser.newContext();
  const guest = await browser.newContext();
  try {
    await signedIn(host, 'Safety Host');
    await signedIn(guest, 'Safety Guest');
    const room = await createTable(host, 'Safety flow');

    const hostPage = await host.newPage();
    const guestPage = await guest.newPage();
    const guestBroadcasts: unknown[] = [];
    guestPage.on('websocket', (socket) =>
      socket.on('framesent', (frame) => guestBroadcasts.push(frame.payload)),
    );
    await hostPage.goto(`/join/${room.room.code}`).catch(rethrowRedacted);
    await hostPage.getByRole('button', { name: 'Join table' }).click();
    await hostPage.getByRole('heading', { name: 'Safety flow' }).waitFor();
    await guestPage.goto(`/join/${room.room.code}`).catch(rethrowRedacted);
    await guestPage.getByRole('button', { name: 'Join table' }).click();
    await guestPage.getByRole('heading', { name: 'Safety flow' }).waitFor();

    await Promise.all([
      hostPage.goto(`/rooms/${room.room.id}/game`),
      guestPage.goto(`/rooms/${room.room.id}/game`),
    ]);
    for (const page of [hostPage, guestPage]) {
      await expect(page.getByRole('heading', { name: 'Game' })).toBeVisible();
      await expect(page.getByText('Connected')).toBeVisible();
    }

    const hostSafety = hostPage.getByRole('region', {
      name: 'Safety controls',
    });
    const lobbyLink = hostPage.getByRole('link', { name: 'Back to lobby' });
    await lobbyLink.focus();
    await expect(lobbyLink).toBeFocused();
    await hostPage.keyboard.press('Tab');
    await expect(
      hostSafety.getByRole('button', { name: 'X-card (anonymous)' }),
    ).toBeFocused();
    await hostPage.keyboard.press('Tab');
    await expect(
      hostSafety.getByRole('button', { name: 'Pause table' }),
    ).toBeFocused();
    await hostPage.keyboard.press('Shift+Tab');
    await expect(
      hostSafety.getByRole('button', { name: 'X-card (anonymous)' }),
    ).toBeFocused();

    const xCard = guestPage.getByRole('button', { name: 'X-card (anonymous)' });
    await xCard.focus();
    await guestPage.keyboard.press('Enter');
    await expect(
      guestPage.getByRole('status').filter({
        hasText:
          /X-card (sent anonymously|was used)\. The DM will steer away next turn\./,
      }),
    ).toBeVisible();
    const sentFlag = guestBroadcasts.find(
      (payload) => typeof payload === 'string' && payload.includes('XCard'),
    );
    expect(sentFlag).toBeTruthy();
    expect(String(sentFlag)).not.toContain('Safety Guest');

    await hostPage.getByRole('button', { name: 'Pause table' }).focus();
    await hostPage.keyboard.press('Enter');
    await expect(
      hostPage.getByText('The table is paused.', { exact: true }),
    ).toBeVisible();
    await expect(
      guestPage.getByText('The table is paused.', { exact: true }),
    ).toBeVisible();
    await expect(
      hostPage.getByRole('button', { name: 'Resume table' }),
    ).toBeVisible();
    await expect(
      guestPage.getByText('Only the host can resume the table.'),
    ).toBeVisible();
  } finally {
    await Promise.all([host.close(), guest.close()]);
  }
});
