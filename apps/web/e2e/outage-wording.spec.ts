import { expect, test } from '@playwright/test';
import { enterGame, openTable, signedIn } from './round-helpers';

const OUTAGE =
  'The storyteller is unavailable. Your action is kept; try again.';

/**
 * With every storyteller endpoint down, a submitted action fails. The socket is still connected, so
 * the page must not describe a reconnect, and the sender's text must come back for a retry.
 */
test('a storyteller outage keeps the action and does not claim the table reconnected', async ({
  browser,
}) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await signedIn(context, 'Outage');
    const room = await openTable(context, 'Outage wording');
    await enterGame(page, room, 'Outage wording');

    // Answer the player's action with the server's outage failure instead of forwarding it.
    await page.routeWebSocket(/\/ws/, (ws) => {
      const upstream = ws.connectToServer();
      ws.onMessage((message) => {
        const frame = JSON.parse(String(message)) as {
          type?: string;
          actionId?: string;
        };
        if (frame.type === 'PlayerAction') {
          ws.send(
            JSON.stringify({
              seq: 9_000,
              type: 'Error',
              payload: {
                code: 'TURN_FAILED',
                message: OUTAGE,
                actionId: frame.actionId,
              },
            }),
          );
          return;
        }
        upstream.send(message);
      });
      upstream.onMessage((message) => ws.send(message));
    });
    await page.goto(`/rooms/${room.id}/game`);
    await expect(page.getByText('Connected to the room.')).toBeVisible();

    await page.getByLabel('Your action').fill('I look around the well.');
    await page.getByRole('button', { name: 'Send action' }).click();

    await expect(page.getByText(OUTAGE)).toBeVisible();
    await expect(page.getByLabel('Your action')).toHaveValue(
      'I look around the well.',
    );
    await expect(
      page.getByRole('button', { name: 'Retry this action' }),
    ).toBeVisible();
    await expect(
      page.getByText(/game server is unavailable|cannot be sent|reconnected/i),
    ).toHaveCount(0);
    await expect(page.getByText('Connected to the room.')).toBeVisible();
  } finally {
    await context.close();
  }
});
