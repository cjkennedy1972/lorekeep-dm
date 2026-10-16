import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

// Real server + Postgres + scripted DM (see apps/server/test/live/serve.live.ts).
// The report goes through the real POST /api/rooms/:id/reports route, not a fixture.
const state = () =>
  JSON.parse(readFileSync(process.env.LIVE_STATE_FILE!, 'utf8')) as {
    token: string;
    table: string;
  };

test('a player reports a DM narration through the real reports route', async ({
  page,
  context,
}) => {
  test.setTimeout(120_000);
  const { token, table } = state();
  await context.addCookies([
    { name: 'sid', value: token, url: 'http://localhost:5174' },
  ]);
  await page.goto(`/rooms/${table}/game`);

  await page.getByLabel('Your action').fill('I look around the crypt');
  await page.getByRole('button', { name: 'Send action' }).click();
  const narration = page
    .getByLabel('Narration log')
    .getByText('Steel rings out across the crypt.', { exact: true });
  await expect(narration).toBeVisible({ timeout: 60_000 });

  await page.getByRole('button', { name: 'Report this message' }).click();
  const form = page.getByRole('form', { name: 'Report message' });
  await form.getByLabel('Category').selectOption('harassment');
  await form.getByLabel('Optional details').fill('Scripted probe report');

  const submitted = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === `/api/rooms/${table}/reports`,
  );
  await form.getByRole('button', { name: 'Submit report' }).click();
  const response = await submitted;
  expect(response.status()).toBe(202);
  expect(await response.json()).toEqual({ received: true });
  const body = response.request().postDataJSON() as {
    messageRef: number;
    category: string;
    reason: string;
  };
  expect(body).toMatchObject({
    category: 'harassment',
    reason: 'Scripted probe report',
  });
  expect(Number.isInteger(body.messageRef)).toBe(true);

  await expect(
    page.getByRole('status').filter({ hasText: 'Report received. Thank you.' }),
  ).toBeVisible();
});
