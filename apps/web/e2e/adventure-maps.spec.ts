import { expect, test } from '@playwright/test';

// Runs on every Playwright project (chromium, firefox, webkit): each Adventure #1 map renders with no errors.
for (const mapId of [
  'adv01-upper-ruins',
  'adv01-warrens',
  'adv01-lamp-vault',
]) {
  test(`${mapId} renders to canvas with no page or console errors`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    await page.goto(`/sandbox/map/${mapId}`);
    await page.getByRole('heading', { name: `Map ${mapId}` }).waitFor();
    const painted = await page.locator('#map-canvas').evaluate((el) => {
      const c = el as HTMLCanvasElement;
      const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
      return d.some((v, i) => i % 4 === 3 && v > 0);
    });
    expect(painted).toBe(true);
    expect(errors).toEqual([]);
  });
}
