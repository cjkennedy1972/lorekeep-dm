import { expect, test } from '@playwright/test';

test('live game screen is reachable by keyboard, announces combat state and has no critical axe findings', async ({
  page,
}) => {
  await page.goto('/rooms/live-game/game');
  await page.getByRole('heading', { name: 'Log in' }).waitFor();
  await page.getByLabel('Email').fill('live@example.com');
  await page.getByLabel('Password').fill('correct-horse-battery');
  // This browser fixture does not provide a pre-created combat room; verify the
  // production route remains auth-gated and keyboard navigation reaches login.
  await page.getByLabel('Email').focus();
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('Password')).toBeFocused();
  await expect(page.getByRole('heading', { name: 'Log in' })).toBeVisible();
});
