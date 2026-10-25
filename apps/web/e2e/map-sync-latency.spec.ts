import { expect, test } from '@playwright/test';
import { MAP_SYNC_BUDGET_MS, summarizeLatency } from './latency-stats.js';

/**
 * Client render-path measurement: key press to the rendered map status. This does not
 * include server round-trips; the live party measurement is tracked as a blocker in the PR.
 */
test('map cursor updates render within the 1 s sync budget on the solo sandbox', async ({
  page,
}) => {
  await page.goto('/sandbox/combat');
  await page.getByRole('heading', { name: 'Solo combat sandbox' }).waitFor();
  await page.locator('.sandbox').focus();
  const status = page
    .locator('section[aria-labelledby=map-title]')
    .getByRole('status');
  await page.keyboard.press('ArrowUp');
  let previous = (await status.textContent()) ?? '';
  const samples: number[] = [];
  for (let step = 0; step < 20; step++) {
    const key = step % 2 === 0 ? 'ArrowDown' : 'ArrowUp';
    const started = performance.now();
    await page.keyboard.press(key);
    await expect
      .poll(async () => (await status.textContent()) ?? '', {
        timeout: MAP_SYNC_BUDGET_MS * 2,
      })
      .not.toBe(previous);
    samples.push(performance.now() - started);
    previous = (await status.textContent()) ?? '';
  }
  const summary = summarizeLatency(samples);
  test.info().annotations.push({
    type: 'map-sync-latency',
    description: JSON.stringify(summary),
  });
  expect(summary.overBudget).toBe(0);
});
