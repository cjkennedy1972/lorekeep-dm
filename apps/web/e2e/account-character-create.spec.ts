import { randomUUID } from 'node:crypto';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type BrowserContext } from '@playwright/test';

const API = 'http://localhost:8787';

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

test('a built character is saved to the account, then bound from the lobby picker', async ({
  browser,
}) => {
  const context = await browser.newContext();
  await signedIn(context, 'Iris');
  const page = await context.newPage();

  await page.goto('/characters/new');
  await page.getByRole('heading', { name: 'Quick build' }).waitFor();
  await page.getByRole('button', { name: 'Build and save character' }).click();
  await expect(
    page.getByRole('heading', { name: 'Your hero is ready' }),
  ).toBeVisible();

  // Keyboard-only: the save offer is reachable and activated with Enter.
  const save = page.getByRole('button', { name: 'Save to my account' });
  await save.focus();
  await expect(save).toBeFocused();
  await page.keyboard.press('Enter');

  const saved = page
    .getByRole('status')
    .filter({ hasText: 'is saved to your account' });
  await expect(saved).toBeVisible();
  const name = ((await saved.textContent()) ?? '').split(' is saved')[0]!;
  expect(name.length).toBeGreaterThan(0);

  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(
    violations.filter((v) => v.impact === 'critical' || v.impact === 'serious'),
  ).toEqual([]);

  const id = await createTable(context, 'Iris Keep');
  await page.goto(`/rooms/${id}`);
  await page.getByRole('heading', { name: 'Iris Keep' }).waitFor();

  const picker = page.getByRole('combobox', { name: 'Your character' });
  const option = picker.locator('option', { hasText: name });
  await expect(option).toHaveCount(1);
  await picker.selectOption((await option.getAttribute('value')) ?? '');
  await page.getByRole('button', { name: 'Bind character' }).click();

  await expect(
    page.getByText('Your character is bound. Your seat is ready to play.'),
  ).toBeVisible();
});

async function ownCharacterNames(context: BrowserContext) {
  const res = await context.request.get(`${API}/api/me/characters`);
  expect(res.ok()).toBe(true);
  return (
    (await res.json()) as { characters: { name: string }[] }
  ).characters.map((c) => c.name);
}

// Documents the duplicate risk: the response is dropped after the server saved the character,
// so the uncertain state is shown, and "Save again anyway" then creates a second copy.
test('a dropped save response is uncertain; "Save again anyway" creates a second copy', async ({
  browser,
}) => {
  const context = await browser.newContext();
  await signedIn(context, 'Nell');
  const page = await context.newPage();

  await page.goto('/characters/new');
  await page.getByRole('heading', { name: 'Quick build' }).waitFor();
  await page.getByRole('button', { name: 'Build and save character' }).click();
  await expect(
    page.getByRole('heading', { name: 'Your hero is ready' }),
  ).toBeVisible();

  const seeded = (await ownCharacterNames(context)).length;
  const armed = await context.request.post(
    `${API}/api/test/me/characters/drop-next-response`,
  );
  expect(armed.ok()).toBe(true);

  await page.getByRole('button', { name: 'Save to my account' }).click();
  const alert = page
    .getByRole('alert')
    .filter({ hasText: 'We may or may not have saved this character' });
  await expect(alert).toBeFocused();
  // No plain retry: the only way to post again is the explicit button.
  await expect(
    page.getByRole('button', { name: 'Save to my account' }),
  ).toHaveCount(0);

  // Keyboard order: the link comes first, and the explicit button is the last stop.
  await page.keyboard.press('Tab');
  await expect(
    page.getByRole('link', { name: 'Check your characters' }),
  ).toBeFocused();
  await page.keyboard.press('Tab');
  const again = page.getByRole('button', { name: 'Save again anyway' });
  await expect(again).toBeFocused();

  // The server did create the character even though the client never heard back.
  const afterDrop = await ownCharacterNames(context);
  expect(afterDrop).toHaveLength(seeded + 1);
  const name = afterDrop[seeded]!;

  await page.keyboard.press('Enter');
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: `${name} is saved to your account` }),
  ).toBeVisible();

  const afterAgain = await ownCharacterNames(context);
  expect(afterAgain).toHaveLength(seeded + 2);
  expect(afterAgain.filter((n) => n === name)).toHaveLength(2);
});
