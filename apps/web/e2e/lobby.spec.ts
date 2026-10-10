import { randomUUID } from 'node:crypto';
import { expect, test, type BrowserContext } from '@playwright/test';

const API = 'http://localhost:8787';

/** The lobby suites test the lobby, so seed the table through the API: the solo start flow (M2-37) opens on the Game screen. */
async function createTable(context: BrowserContext, name: string) {
  const res = await context.request.post(`${API}/api/tables`, {
    data: {
      name,
      adventureId: 'adventure:fixture-1',
      difficulty: 'moderate',
      startingLevel: 1,
    },
  });
  expect(res.ok()).toBe(true);
  return ((await res.json()) as { game: { id: string } }).game.id;
}

async function signedIn(context: BrowserContext, name: string) {
  const res = await context.request.post(`${API}/api/signup`, {
    data: {
      email: `${name.toLowerCase()}-${randomUUID()}@example.com`,
      password: 'correct-horse-battery',
      displayName: name,
      birthdate: '1990-01-01',
    },
  });
  expect(res.ok()).toBe(true);
}

test('keyboard-only: create a table, copy the invite, two players see each other', async ({
  browser,
}) => {
  const host = await browser.newContext({
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  await signedIn(host, 'Harper');
  const page = await host.newPage();
  const id = await createTable(host, 'Keyboard Keep');
  await page.goto(`/rooms/${id}`);
  // A solo game opens on the Game screen; this suite exercises the lobby, one URL up.
  await page.getByRole('heading', { name: 'Keyboard Keep' }).waitFor();

  await page.getByRole('button', { name: 'Copy invite link' }).focus();
  await page.keyboard.press('Enter');
  await expect(
    page.getByText('Invite link copied to clipboard.'),
  ).toBeVisible();
  const link = await page.evaluate(() => navigator.clipboard.readText());
  expect(link).toMatch(/\/join\/[A-Za-z0-9_-]{22}$/);

  // Second browser profile: logged out first, then redirected back after sign-in.
  const guest = await browser.newContext();
  const tab = await guest.newPage();
  await tab.goto(link);
  await expect(tab).toHaveURL(/\/login$/); // login screen arrives with M0-24; redirect is what matters here
  await signedIn(guest, 'Nia');
  await tab.goto(link);
  await tab.getByRole('heading', { name: 'Keyboard Keep' }).waitFor();

  const seats = page.getByRole('list', { name: /players/i });
  await expect(seats).toContainText('Harper (online)');
  await expect(seats).toContainText('Nia (online)');
  await expect(tab.getByRole('list', { name: /players/i })).toContainText(
    'Harper (online)',
  );
});

test('navigation to a new lobby clears the plaintext invite from history.state', async ({
  browser,
}) => {
  const host = await browser.newContext();
  await signedIn(host, 'History');
  const page = await host.newPage();
  const id = await createTable(host, 'History Hall');
  await page.goto(`/rooms/${id}`);
  await page.getByRole('heading', { name: 'History Hall' }).waitFor();

  const invite = (await page.getByLabel('Invite link').inputValue()).split(
    '/join/',
  )[1];
  expect(invite).toMatch(/^[A-Za-z0-9_-]{22}$/);
  // No navigation state carries the invite any more (solo creation opens the Game screen).
  await expect
    .poll(() => page.evaluate(() => history.state?.usr ?? null))
    .toBeNull();
  expect(
    JSON.stringify(await page.evaluate(() => history.state)),
  ).not.toContain(invite);
  await host.close();
});

test('lobby fits a 360px viewport without horizontal scroll', async ({
  browser,
}) => {
  const ctx = await browser.newContext({
    viewport: { width: 360, height: 740 },
  });
  await signedIn(ctx, 'Narrow');
  const page = await ctx.newPage();
  const id = await createTable(ctx, 'Tiny Table');
  await page.goto(`/rooms/${id}`);
  await page.getByRole('heading', { name: 'Tiny Table' }).waitFor();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > innerWidth,
  );
  expect(overflow).toBe(false);
});
