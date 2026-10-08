import { expect, test } from '@playwright/test';

// Runs on every Playwright project (chromium, firefox, webkit).
test('sandbox renders the crypt map to canvas with no page or console errors', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto('/sandbox/combat');
  await page.getByRole('heading', { name: 'Solo combat sandbox' }).waitFor();
  const painted = await page.locator('#crypt-map').evaluate((el) => {
    const c = el as HTMLCanvasElement;
    const data = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    return data.some((v, i) => i % 4 === 3 && v > 0);
  });
  expect(painted).toBe(true);
  expect(errors).toEqual([]);
});
