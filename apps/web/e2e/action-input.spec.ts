import { expect, test } from '@playwright/test';

test('action input enters pending state promptly and fits a 360px viewport', async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto('/sandbox/action-input');
  await page.getByLabel('Your action').fill('I look around');
  const start = Date.now();
  await page.getByRole('button', { name: 'Send action' }).press('Enter');
  await expect(page.getByRole('status')).toContainText('The DM is thinking');
  expect(Date.now() - start).toBeLessThanOrEqual(300);
  const sizes = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(sizes.scroll).toBeLessThanOrEqual(sizes.viewport);
});
