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
