import { expect, test, type BrowserContext } from '@playwright/test';

const API = 'http://localhost:8787';
let n = 0;

async function signedIn(context: BrowserContext, name: string) {
  const res = await context.request.post(`${API}/api/signup`, {
    data: {
      email: `${name.toLowerCase()}${Date.now()}${n++}@example.com`,
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
  await page.goto('/rooms');
  await page.getByRole('heading', { name: 'My games' }).waitFor();

  await page.getByLabel('Game name').focus();
  await page.keyboard.type('Keyboard Keep');
  await page.keyboard.press('Enter');
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
  await page.goto('/rooms');
  await page.getByLabel('Game name').fill('History Hall');
  await page.getByRole('button', { name: 'Create solo game' }).click();
  await page.getByRole('heading', { name: 'History Hall' }).waitFor();

  const invite = (await page.getByLabel('Invite link').inputValue()).split(
    '/join/',
  )[1];
  expect(invite).toMatch(/^[A-Za-z0-9_-]{22}$/);
  await expect.poll(() => page.evaluate(() => history.state?.usr)).toBeNull();
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
  await page.goto('/rooms');
  await page.getByLabel('Game name').fill('Tiny Table');
  await page.getByRole('button', { name: 'Create solo game' }).click();
  await page.getByRole('heading', { name: 'Tiny Table' }).waitFor();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > innerWidth,
  );
  expect(overflow).toBe(false);
});
