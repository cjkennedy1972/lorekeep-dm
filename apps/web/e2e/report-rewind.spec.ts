import { expect, test } from '@playwright/test';

test('report and rewind banner are reachable with the keyboard', async ({
  page,
}) => {
  await page.route('**/api/me', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        account: { id: 'browser-account', displayName: 'Browser Player' },
      }),
    }),
  );
  await page.goto('/e2e/report-rewind-fixture.html');
  let reported: unknown;
  await page.route('**/api/report-fixture', async (route) => {
    reported = route.request().postDataJSON();
    await route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: '{"received":true}',
    });
  });
  const report = page.getByRole('button', { name: 'Report this message' });
  const narrationReport = report.first();
  await narrationReport.focus();
  await expect(narrationReport).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('form', { name: 'Report message' }),
  ).toBeVisible();
  await page.getByLabel('Category').selectOption('harassment');
  await page.getByLabel('Optional details').fill('Needs review');
  await page.getByRole('button', { name: 'Submit report' }).focus();
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('status').filter({ hasText: 'Report received. Thank you.' }),
  ).toHaveText('Report received. Thank you.');
  await expect(
    page.getByText('A sealed door opens.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText('rejected-turn')).toHaveCount(0);
  expect(reported).toEqual({
    messageRef: 44,
    category: 'harassment',
    reason: 'Needs review',
  });

  await page.getByRole('button', { name: 'Deliver rewind event' }).focus();
  await page.keyboard.press('Enter');
  const banner = page.locator('.narration-log__rewind');
  await expect(banner).toContainText('The host rewound the last DM turn');
  await expect(banner).toHaveAttribute('aria-live', 'polite');
});
