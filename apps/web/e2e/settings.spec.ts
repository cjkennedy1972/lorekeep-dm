import { expect, test } from '@playwright/test';

const PW = 'correct-horse-battery';

test('keyboard: sessions, export, and delete confirmation', async ({
  page,
}) => {
  const email = `set${Date.now()}${Math.floor(Math.random() * 1000)}@example.com`;
  await page.goto('/signup');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Display name').fill('Kay');
  await page.getByLabel('Password').fill(PW);
  await page.getByLabel('Date of birth').fill('1990-01-01');
  await page.locator('#terms').check();
  await page.locator('#adult').check();
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByRole('heading', { name: 'Check your email' }).waitFor();

  await page.goto('/settings');
  await page.getByRole('heading', { name: 'Devices signed in' }).waitFor();
  await expect(
    page.getByRole('list', { name: 'Signed-in devices' }),
  ).toContainText('(this device)');

  await page.getByRole('button', { name: 'Export my data' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Preparing' }),
  ).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Download your data' }),
  ).toBeVisible({ timeout: 10_000 });

  const opener = page.getByRole('button', { name: /Delete my account/ });
  await opener.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Delete your account?' });
  await expect(dialog).toContainText('cannot be undone');
  await expect(page.getByLabel('Your password')).toBeFocused();
  for (let i = 0; i < 6; i++) await page.keyboard.press('Tab'); // never leaves the dialog
  expect(
    await page.evaluate(
      () => !!document.activeElement?.closest('[role=dialog]'),
    ),
  ).toBe(true);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();

  await page.keyboard.press('Enter');
  await page.getByLabel('Your password').fill(PW);
  await page.getByLabel(/Type DELETE MY ACCOUNT/).fill('DELETE MY ACCOUNT');
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('heading', { name: 'Lorekeep-DM' }),
  ).toBeVisible();
  await page.goto('/rooms');
  await expect(page).toHaveURL(/\/login/);
});
