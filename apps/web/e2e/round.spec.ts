import { randomUUID } from 'node:crypto';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type BrowserContext } from '@playwright/test';

const API = 'http://localhost:8787';

async function signedIn(context: BrowserContext, name: string) {
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

async function openTable(
  host: BrowserContext,
  guest: BrowserContext,
  name: string,
) {
  const response = await host.request.post(`${API}/api/rooms`, {
    data: { name },
  });
  expect(response.ok()).toBe(true);
  const { room } = (await response.json()) as {
    room: { id: string; code: string };
  };
  return room;
}

test('keyboard round flow: submit, edit and withdraw an action; every seat sees the submission', async ({
  browser,
}) => {
  const host = await browser.newContext();
  const guest = await browser.newContext();
  try {
    await signedIn(host, 'Round Host');
    await signedIn(guest, 'Round Guest');
    const room = await openTable(host, guest, 'Round flow');

    const hostPage = await host.newPage();
    const guestPage = await guest.newPage();
    for (const page of [hostPage, guestPage]) {
      await page.goto(`/join/${room.code}`);
      await page.getByRole('button', { name: 'Join table' }).click();
      await page.getByRole('heading', { name: 'Round flow' }).waitFor();
    }
    await Promise.all([
      hostPage.goto(`/rooms/${room.id}/game`),
      guestPage.goto(`/rooms/${room.id}/game`),
    ]);
    for (const page of [hostPage, guestPage]) {
      await expect(page.getByText('Connected')).toBeVisible();
    }

    const guestRound = guestPage.getByRole('region', { name: 'Round' });
    await guestPage.getByLabel('Your action').fill('I look around.');
    await guestPage.getByRole('button', { name: 'Send action' }).press('Enter');
    await expect(guestRound.getByText('Round Guest: submitted')).toBeVisible();
    await expect(
      hostPage
        .getByRole('region', { name: 'Round' })
        .getByText('Round Guest: submitted'),
    ).toBeVisible();

    await guestRound.getByRole('button', { name: 'Edit action' }).focus();
    await guestPage.keyboard.press('Enter');
    const editBox = guestRound.getByLabel('Edit your action');
    await editBox.fill('I open the door.');
    await guestRound.getByRole('button', { name: 'Save edit' }).press('Enter');
    await expect(guestRound.getByText('I open the door.')).toBeVisible();

    await guestRound.getByRole('button', { name: 'Withdraw action' }).focus();
    await guestPage.keyboard.press('Enter');
    await expect(guestRound.getByText('Round Guest: waiting')).toBeVisible();
    await expect(
      hostPage
        .getByRole('region', { name: 'Round' })
        .getByText('Round Guest: waiting'),
    ).toBeVisible();
  } finally {
    await Promise.all([host.close(), guest.close()]);
  }
});

test('host controls validate the round timer, save it, and pass axe', async ({
  browser,
}) => {
  const host = await browser.newContext();
  const guest = await browser.newContext();
  try {
    await signedIn(host, 'Timer Host');
    await signedIn(guest, 'Timer Guest');
    const room = await openTable(host, guest, 'Timer table');

    const hostPage = await host.newPage();
    await hostPage.goto(`/join/${room.code}`);
    await hostPage.getByRole('button', { name: 'Join table' }).click();
    await hostPage.getByRole('heading', { name: 'Timer table' }).waitFor();
    await hostPage.goto(`/rooms/${room.id}/game`);
    await expect(hostPage.getByText('Connected')).toBeVisible();

    const controls = hostPage.getByRole('region', { name: 'Host controls' });
    await controls.getByLabel('No time limit').uncheck();
    await controls.getByLabel('Round timer in seconds (30 to 600)').fill('5');
    await controls.getByRole('button', { name: 'Save round timer' }).focus();
    await hostPage.keyboard.press('Enter');
    await expect(
      controls.getByRole('status').filter({ hasText: '30 seconds' }),
    ).toBeVisible();

    await controls.getByLabel('Round timer in seconds (30 to 600)').fill('120');
    await controls.getByRole('button', { name: 'Save round timer' }).focus();
    await hostPage.keyboard.press('Enter');
    await expect(
      controls.getByRole('status').filter({ hasText: 'Round timer saved.' }),
    ).toBeVisible();

    const unavailable = controls.getByRole('button', { name: 'Transfer host' });
    await expect(unavailable).toBeDisabled();

    const results = await new AxeBuilder({ page: hostPage })
      .include('.round-panel')
      .include('.host-controls')
      .analyze();
    const blocking = results.violations.filter((v) =>
      ['critical', 'serious'].includes(v.impact ?? ''),
    );
    expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);
  } finally {
    await Promise.all([host.close(), guest.close()]);
  }
});
