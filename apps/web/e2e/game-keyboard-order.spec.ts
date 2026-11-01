import { expect, test } from '@playwright/test';
import { enterGame, openTable, signedIn } from './round-helpers';

test('skip link reaches the action box and the composer precedes map controls in tab order', async ({
  browser,
}) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await signedIn(context, 'Keyboard');
    const room = await openTable(context, 'Keyboard order');
    await enterGame(page, room, 'Keyboard order');
    await page.setViewportSize({ width: 1280, height: 900 });

    // Without the skip link: plain Tab stops from page load to the action box.
    await page.goto(`/rooms/${room.id}/game`);
    await expect(page.getByText('Connected')).toBeVisible();
    let stops = 0;
    for (; stops < 30; ) {
      await page.keyboard.press('Tab');
      stops += 1;
      const id = await page.evaluate(() => document.activeElement?.id);
      if (id === 'player-action') break;
    }
    // App nav (4 links) and the safety toolbar necessarily come first; was 24+ before.
    expect(stops).toBeLessThanOrEqual(14);
    // The composer is reached before any map or combat control.
    const mapFocused = await page.evaluate(() =>
      Boolean(document.activeElement?.closest('.game-area--map')),
    );
    expect(mapFocused).toBe(false);

    // With the skip links: Tab, Enter on the shell link, Tab, Enter reaches the box in 2 Tabs.
    await page.goto(`/rooms/${room.id}/game`);
    await expect(page.getByText('Connected')).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(
      page.getByRole('link', { name: 'Skip to main content' }),
    ).toBeFocused();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Tab');
    const skip = page.getByRole('link', { name: 'Skip to your action' });
    await expect(skip).toBeFocused();
    await expect(skip).toBeInViewport();
    await page.keyboard.press('Enter');
    await expect(page.getByLabel('Your action')).toBeFocused();

    const order = await page.evaluate(() => {
      const a = document.getElementById('player-action')!;
      const b = document.querySelector('.game-area--map')!;
      return Boolean(
        a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING,
      );
    });
    expect(order).toBe(true);
  } finally {
    await context.close();
  }
});
