import { expect, test } from '@playwright/test';

test('skip link is first tab stop and focus ring is visible', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('heading', { name: 'Lorekeep-DM' }).waitFor();
  await page.keyboard.press('Tab');
  const skip = page.getByRole('link', { name: 'Skip to main content' });
  await expect(skip).toBeFocused();
  await expect(skip).toBeVisible();
  expect(await skip.evaluate((e) => getComputedStyle(e).outlineStyle)).not.toBe(
    'none',
  );
});

test('reduced motion disables transitions', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  const d = await page
    .getByRole('link', { name: 'Settings' })
    .evaluate((e) => getComputedStyle(e).transitionDuration);
  expect(parseFloat(d)).toBeLessThan(0.001);
});
