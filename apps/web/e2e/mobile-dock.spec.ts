import { expect, test, type WebSocketRoute } from '@playwright/test';
import { enterGame, openTable, signedIn } from './round-helpers';

const LAST_LINE = 'Final beat: the goblin lunges and the lantern goes out.';

/**
 * The narration pane sits above a sticky composer on phones. Scrolling the page to the story's end
 * must leave the last narration line above the composer rather than behind it.
 */
test('the last narration line stays above the sticky composer at 390px', async ({
  browser,
}, testInfo) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await signedIn(context, 'Dock');
    const room = await openTable(context, 'Mobile dock');
    await enterGame(page, room, 'Mobile dock');

    // Proxy the room socket so narration frames can be injected into the live game screen.
    let injector: WebSocketRoute | undefined;
    await page.routeWebSocket(/\/ws/, (ws) => {
      const upstream = ws.connectToServer();
      ws.onMessage((message) => upstream.send(message));
      upstream.onMessage((message) => ws.send(message));
      injector = ws;
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/rooms/${room.id}/game`);
    await expect(page.getByText('Connected to the room.')).toBeVisible();

    for (let i = 1; i <= 5; i++)
      injector?.send(
        JSON.stringify({
          seq: 900 + i,
          type: 'NarrationCompleted',
          payload: {
            turnId: `dock-${i}`,
            text: `Paragraph ${i}. The cold draft from the well brushes past your ankles while the lantern gutters over the broken gatehouse and the goblins circle wider.`,
          },
        }),
      );
    injector?.send(
      JSON.stringify({
        seq: 910,
        type: 'NarrationCompleted',
        payload: { turnId: 'dock-6', text: LAST_LINE },
      }),
    );
    await expect(page.getByText(LAST_LINE)).toBeAttached();

    // Scroll the page so the story's bottom edge is where a user would land it.
    await page.evaluate(() =>
      document
        .querySelector('.game-area--story')
        ?.scrollIntoView({ block: 'end' }),
    );
    const { lineBottom, dockTop } = await page.evaluate(() => {
      const line = Array.from(
        document.querySelectorAll('#game-story p, #game-story span'),
      ).find((el) => el.textContent?.includes('Final beat'));
      const dock = document.querySelector('.game-area--dock');
      return {
        lineBottom: line?.getBoundingClientRect().bottom ?? Infinity,
        dockTop: dock?.getBoundingClientRect().top ?? 0,
      };
    });
    // DOCK_SHOT names the screenshot so before and after runs can be compared side by side.
    const shot =
      process.env.DOCK_SHOT ?? testInfo.outputPath('mobile-390-story-end.png');
    await page.screenshot({ path: shot });
    expect(lineBottom).toBeLessThanOrEqual(dockTop);
  } finally {
    await context.close();
  }
});
