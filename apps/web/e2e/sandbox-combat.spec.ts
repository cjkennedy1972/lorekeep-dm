import { expect, test } from '@playwright/test';

test('keyboard-only crypt combat resolves engine path, reaction, area spell and monster turns without API requests', async ({
  page,
}) => {
  const nonStatic: string[] = [];
  page.on('request', (request) => {
    if (
      !['document', 'script', 'stylesheet', 'image', 'font'].includes(
        request.resourceType(),
      )
    )
      nonStatic.push(request.url());
  });
  await page.goto('/sandbox/combat');
  await page.getByRole('heading', { name: 'Solo combat sandbox' }).waitFor();
  await page.locator('.sandbox').focus();
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await expect(
    page.locator('section[aria-labelledby=map-title]').getByRole('status'),
  ).toContainText('Path preview:');
  const cost = await page.getByTestId('path-cost').textContent();
  expect(Number(cost?.replace(' ft', ''))).toBeGreaterThan(0);
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('dialog', { name: 'Opportunity attack' }),
  ).toBeVisible();
  const status = page
    .locator('section[aria-labelledby=map-title]')
    .getByRole('status');
  for (let reaction = 0; reaction < 3; reaction++) {
    if (
      !(await page
        .getByRole('dialog', { name: 'Opportunity attack' })
        .isVisible())
    )
      break;
    await page.keyboard.press('y');
  }
  await expect(status).toContainText('Preview the Burning Hands area');
  await expect(page.getByRole('region', { name: 'Combat log' })).toContainText(
    'OpportunityTriggered',
  );
  await expect(page.getByRole('region', { name: 'Combat log' })).toContainText(
    'ReactionResolved',
  );
  await page.keyboard.press('a');
  const affected = page.getByRole('list', { name: 'Affected creatures' });
  await expect(affected.locator('li')).toHaveCount(2);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('region', { name: 'Combat log' })).toContainText(
    'AreaResolved',
  );
  await expect(page.getByRole('region', { name: 'Combat log' })).toContainText(
    'HpChanged',
  );
  await expect(page.getByTestId('combat-ended')).toHaveText('CombatEnded');
  await expect(page.getByRole('region', { name: 'Combat log' })).toContainText(
    'CombatEnded',
  );
  expect(nonStatic).toEqual([]);
});
