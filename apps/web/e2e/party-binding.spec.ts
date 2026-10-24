import { randomUUID } from 'node:crypto';
import { expect, test, type BrowserContext } from '@playwright/test';

const API = 'http://localhost:8787';

/** Seeds a table through the API so the lobby opens directly, as lobby.spec.ts does. */
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

async function ownCharacters(context: BrowserContext) {
  const res = await context.request.get(`${API}/api/me/characters`);
  expect(res.ok()).toBe(true);
  return (
    (await res.json()) as {
      characters: { id: string; name: string; revision: number }[];
    }
  ).characters;
}

test('an unbound seat is told to bind; keyboard alone binds a character', async ({
  browser,
}) => {
  const host = await browser.newContext();
  await signedIn(host, 'Quinn');
  const page = await host.newPage();
  const id = await createTable(host, 'Binding Keep');
  await page.goto(`/rooms/${id}`);
  await page.getByRole('heading', { name: 'Binding Keep' }).waitFor();

  await expect(
    page.getByRole('heading', { name: 'Bind a character to play' }),
  ).toBeVisible();
  await expect(
    page.getByText('Party play waits until every seat has a character bound.'),
  ).toBeVisible();

  const picker = page.getByLabel('Your character');
  const bind = page.getByRole('button', { name: 'Bind character' });
  await picker.focus();
  await expect(picker).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(picker).toHaveValue(/.+/);
  await page.keyboard.press('Tab');
  await expect(bind).toBeFocused();
  await page.keyboard.press('Enter');

  await expect(
    page.getByText('Your character is bound. Your seat is ready to play.'),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Bind character' }),
  ).toHaveCount(0);
  // The table also seats a scripted player who has not bound, so the count is 1 of 2.
  await expect(
    page.getByText('1 of 2 seats have a character bound.'),
  ).toBeVisible();
  await expect(
    page.getByRole('listitem').filter({ hasText: 'Scripted Sam' }),
  ).toContainText('no character bound');
  await expect(
    page.getByRole('listitem').filter({ hasText: 'Quinn' }),
  ).toContainText('character bound');
});

test('a character that changed since the list loaded is rejected with an accessible alert', async ({
  browser,
}) => {
  const host = await browser.newContext();
  await signedIn(host, 'Rowan');
  const page = await host.newPage();
  const id = await createTable(host, 'Stale Keep');
  await page.goto(`/rooms/${id}`);
  await page.getByRole('heading', { name: 'Stale Keep' }).waitFor();
  await expect(picker(page)).toBeVisible();

  // The sheet changes after the picker loaded, so the bind carries an old revision.
  const [first] = await ownCharacters(host);
  const bumped = await host.request.post(
    `${API}/api/test/characters/${first.id}/revision`,
  );
  expect(bumped.ok()).toBe(true);

  await page
    .getByRole('combobox', { name: 'Your character' })
    .selectOption(first.id);
  await page.getByRole('button', { name: 'Bind character' }).click();

  // The mock sends ACTION_REJECTED for every bind failure, as the server does, so the generic message is what shows.
  await expect(
    page.getByRole('alert').filter({ hasText: 'could not be bound' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Bind character' }),
  ).toBeEnabled();
});

function picker(page: import('@playwright/test').Page) {
  return page.getByLabel('Your character');
}
