import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

type Seed = { token: string; table: string };
const state = () =>
  JSON.parse(readFileSync(process.env.LIVE_STATE_FILE!, 'utf8')) as Seed;

test('signed-in solo start, My games and resume recap survive a fresh browser context', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const { token } = state();
  const context = await browser.newContext();
  const page = await context.newPage();
  const timings: Record<string, number> = {};
  await context.addCookies([
    { name: 'sid', value: token, url: 'http://localhost:5174' },
  ]);
  const start = Date.now();
  await page.goto('/');
  await page.getByRole('link', { name: 'Start a solo game' }).click();
  await page.getByLabel('Game name').fill('Resume Proof');
  await page.getByLabel('Starting level').selectOption('2');
  await page.getByRole('button', { name: 'Create solo game' }).click();
  const createdGame = await page.waitForResponse(
    (response) =>
      response.url().includes('/api/tables') &&
      response.request().method() === 'POST',
  );
  expect(createdGame.ok()).toBeTruthy();
  const created = await createdGame.json();
  await expect(page.getByLabel('Your action')).toBeVisible({ timeout: 30_000 });
  timings.firstNarrationReadyMs = Date.now() - start;
  expect(created.game).toMatchObject({
    name: 'Resume Proof',
    startingLevel: 2,
  });
  await context.close();

  const fresh = await browser.newContext();
  await fresh.addCookies([
    { name: 'sid', value: token, url: 'http://localhost:5174' },
  ]);
  const resumed = await fresh.newPage();
  const resumeStart = Date.now();
  await resumed.goto('/rooms');
  await resumed.getByRole('link', { name: 'Resume Resume Proof' }).click();
  await expect(resumed.getByRole('heading', { name: 'Round 1' })).toHaveCount(
    0,
  );
  await expect(resumed.getByRole('heading', { name: 'Game' })).toBeVisible();
  await expect(resumed.getByLabel('Your action')).toBeVisible({
    timeout: 30_000,
  });
  timings.resumeAndStateReadyMs = Date.now() - resumeStart;
  console.log(`M2-37 flow timings: ${JSON.stringify(timings)}`);
  await fresh.close();
});
