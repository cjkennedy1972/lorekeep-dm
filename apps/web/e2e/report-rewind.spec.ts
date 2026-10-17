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
  const rewind = page.getByRole('button', { name: 'Deliver rewind event' });
  await narrationReport.focus();
  await expect(narrationReport).toBeFocused();
  await rewind.focus();
  await expect(rewind).toBeFocused();
  await narrationReport.focus();
  await expect(narrationReport).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('form', { name: 'Report message' }),
  ).toBeVisible();
  const category = page.getByLabel('Category');
  await expect(category).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('Optional details')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(
    page.getByRole('button', { name: 'Submit report' }),
  ).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(
    page.getByRole('button', { name: 'Submit report' }),
  ).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByLabel('Optional details')).toBeFocused();
  await category.selectOption('harassment');
  await page.getByLabel('Optional details').fill('Needs review');
  await page.getByRole('button', { name: 'Submit report' }).focus();
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('status').filter({ hasText: 'Report received. Thank you.' }),
  ).toHaveText('Report received. Thank you.');
  await expect(narrationReport).toBeFocused();
  await expect(
    page.getByText('A sealed door opens.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText('rejected-turn')).toHaveCount(0);
  expect(reported).toEqual({
    messageRef: 44,
    category: 'harassment',
    reason: 'Needs review',
  });

  await rewind.focus();
  await page.keyboard.press('Enter');
  const banner = page.locator('.narration-log__rewind');
  await expect(banner).toContainText('The host rewound the last DM turn');
  await expect(banner).toHaveAttribute('aria-live', 'polite');
});
