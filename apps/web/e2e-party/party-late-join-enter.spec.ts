import { mkdirSync, readFileSync } from 'node:fs';
import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';
import { mintSeatResume } from './seat-resume';

// Real server + Postgres (see apps/server/test/live/serve.party.live.ts, the late-join table).
// A solo host plays; a late joiner requests a seat, the host approves and resolves the round,
// the joiner's device is approved, and the joiner enters the game from the lobby.
type Account = { accountId: string; token: string };
type LateJoinState = {
  lateJoin: {
    table: string;
    invite: string;
    host: Account;
    joiner: Account;
  };
};
type ServerFrame = { type: string; payload?: Record<string, unknown> };

const state = () =>
  JSON.parse(
    readFileSync(process.env.LIVE_STATE_FILE!, 'utf8'),
  ) as LateJoinState;
const origin = `http://localhost:${process.env.LIVE_WEB_PORT ?? 5176}`;
const shotDir =
  process.env.LATE_JOIN_SHOT_DIR ?? 'test-results/late-join-steps';

async function openAs(
  browser: Browser,
  account: Account,
  table: string,
  path: string,
) {
  const context = await browser.newContext();
  await context.addCookies([
    { name: 'sid', value: account.token, url: origin },
  ]);
  // The host is seated at server boot; its resume token expires 30 s later, so mint it now.
  await mintSeatResume(context, origin, table, account);
  // Host tools and the chat are collapsed drawers; the host needs Host tools open.
  await context.addInitScript(() => {
    localStorage.setItem('lorekeep.drawer.host', 'open');
    localStorage.removeItem('lorekeep.drawer.chat');
  });
  const page = await context.newPage();
  const frames: ServerFrame[] = [];
  page.on('websocket', (socket) =>
    socket.on('framereceived', (event) => {
      if (typeof event.payload !== 'string') return;
      try {
        frames.push(JSON.parse(event.payload) as ServerFrame);
      } catch {
        // Non-JSON frames are not protocol messages.
      }
    }),
  );
  await page.goto(path);
  if (new URL(path, origin).pathname.endsWith('/game'))
    await expect(
      page.getByRole('status').filter({ hasText: 'Connected to the room.' }),
    ).toBeVisible({ timeout: 30_000 });
  return { accountId: account.accountId, context, page, frames };
}

async function closeAs(view: { accountId: string; context: BrowserContext }) {
  await view.context.close();
  await new Promise((resolve) => setTimeout(resolve, 100));
}

// Logs the step, the page URL, and a screenshot so a hang shows the exact step it stopped at.
async function step(
  who: string,
  page: Page,
  name: string,
  run: () => Promise<void>,
) {
  console.log(`[late-join] START ${who}: ${name} url=${page.url()}`);
  try {
    await run();
    console.log(`[late-join] OK    ${who}: ${name} url=${page.url()}`);
  } catch (error) {
    console.log(`[late-join] FAIL  ${who}: ${name} url=${page.url()}`);
    throw error;
  } finally {
    const file = `${shotDir}/${who}-${name.replace(/\W+/g, '-')}.png`;
    mkdirSync(shotDir, { recursive: true });
    await page
      .screenshot({ path: file, fullPage: true })
      .catch(() => undefined);
    console.log(`[late-join] shot ${file}`);
  }
}

test.describe.serial('late joiner enters the game (real server)', () => {
  test.use({ actionTimeout: 10_000, expect: { timeout: 10_000 } });
  test.setTimeout(90_000);
  test.beforeEach(async ({ request }) => {
    const response = await request.post('/api/test/reset-auth-attempts');
    expect(response.ok()).toBe(true);
  });

  test('a late joiner who is approved, bound, and eligible enters the game and can act', async ({
    browser,
  }) => {
    const { lateJoin } = state();
    const { table, invite, host, joiner } = lateJoin;
    const hostView = await openAs(browser, host, table, `/rooms/${table}/game`);
    const joinerView = await openAs(browser, joiner, table, `/join/${invite}`);
    const hostPage = hostView.page;
    const joinerPage = joinerView.page;
    try {
      await step('joiner', joinerPage, '1-character-enabled', async () => {
        await expect(joinerPage.getByLabel('Your character')).toBeEnabled();
      });

      // 1. The joiner picks an owned character and requests a seat; the host has to approve.
      await step('joiner', joinerPage, '2-request-join', async () => {
        // The joiner has one owned character, which the field preselects.
        await expect(joinerPage.getByLabel('Your character')).not.toHaveValue(
          '',
        );
        const requested = joinerPage.waitForResponse(
          (response) =>
            response.request().method() === 'POST' &&
            new URL(response.url()).pathname === `/api/invites/${invite}/join`,
        );
        await joinerPage.getByRole('button', { name: 'Join table' }).click();
        expect((await requested).status()).toBe(409);
        await expect(joinerPage.getByRole('alert').first()).not.toBeEmpty();
      });

      // 2. The host approves the request and resolves the open round, which admits the seat.
      const controls = hostPage.getByRole('region', { name: 'Host controls' });
      await step('host', hostPage, '3-approve-request', async () => {
        const approve = controls.getByRole('button', {
          name: /^Approve /,
          exact: false,
        });
        await expect(approve).toBeEnabled();
        await approve.click();
      });
      await step('host', hostPage, '4-resolve-round', async () => {
        const resolve = controls.getByRole('button', {
          name: 'Resolve round now',
          exact: true,
        });
        await expect(resolve).toBeEnabled();
        await resolve.click();
      });

      // 3. The joiner retries the join and the host approves the device claim for the new seat.
      await step('joiner', joinerPage, '5-retry-join', async () => {
        await joinerPage.getByRole('button', { name: 'Join table' }).click();
      });
      const claims = hostPage.getByRole('region', { name: 'Device claims' });
      const claimApprove = claims.getByRole('button', {
        name: 'Approve',
        exact: true,
      });
      const enterLink = joinerPage.getByRole('link', {
        name: 'Enter game',
        exact: true,
      });
      // A device claim appears only when the joiner's socket has no seat token; approve it if requested.
      await step(
        'host',
        hostPage,
        '6-approve-device-claim-if-requested',
        async () => {
          const requested = await claimApprove
            .waitFor({ state: 'visible', timeout: 5_000 })
            .then(() => true)
            .catch(() => false);
          console.log(`[late-join] device claim requested=${requested}`);
          if (requested) await claimApprove.click();
        },
      );

      // 4. The joiner lands in the lobby, bound to the seat, with an Enter game control.
      const boundText = joinerPage.getByText(
        'Your character is bound. Your seat is ready to play.',
      );
      await step('joiner', joinerPage, '8-lobby', async () => {
        await expect(joinerPage).toHaveURL(new RegExp(`/rooms/${table}$`), {
          timeout: 60_000,
        });
      });
      // The joiner's snapshot ack is recorded after the round that admitted the seat, so admission
      // (and the bind gate) waits for the next round boundary: the host resolves again.
      await step('host', hostPage, '9a-resolve-round-after-ack', async () => {
        const resolve = controls.getByRole('button', {
          name: 'Resolve round now',
          exact: true,
        });
        await expect(resolve).toBeEnabled({ timeout: 60_000 });
        await resolve.click();
      });
      await step('joiner', joinerPage, '9-bind-character', async () => {
        // The lobby offers the bind form once the seat is admitted; bind the preselected character.
        const bind = joinerPage.getByRole('button', {
          name: 'Bind character',
          exact: true,
        });
        await expect(bind.or(boundText)).toBeVisible({ timeout: 60_000 });
        if (await bind.isVisible()) await bind.click();
        await expect(boundText)
          .toBeVisible({ timeout: 60_000 })
          .catch(async (error) => {
            // Show what the joiner sees instead of the bound status.
            const received = joinerView.frames.map((frame) => frame.type);
            console.log(
              `[late-join] joiner frames=${JSON.stringify(received.slice(-40))}`,
            );
            console.log(
              `[late-join] joiner errors=${JSON.stringify(joinerView.frames.filter((frame) => frame.type === 'Error').map((frame) => frame.payload))}`,
            );
            const alerts = await joinerPage.getByRole('alert').allInnerTexts();
            const statuses = await joinerPage
              .getByRole('status')
              .allInnerTexts();
            console.log(
              `[late-join] bind alerts=${JSON.stringify(alerts)} statuses=${JSON.stringify(statuses)}`,
            );
            throw error;
          });
      });

      // 5. Enter game is a link to the game route. A real user clicks it; it must reach /game.
      await step('joiner', joinerPage, '9-enter-game-link', async () => {
        await expect(enterLink).toBeVisible();
        console.log(
          `[late-join] enter-game tag=${await enterLink.evaluate((el) => el.tagName)}`,
        );
        await enterLink.click();
        await expect(joinerPage).toHaveURL(new RegExp(`/rooms/${table}/game$`));
      });

      // 6. In the next round the joiner's action input renders and the action is accepted.
      await step('joiner', joinerPage, '10-action-input', async () => {
        await expect(joinerPage.getByLabel('Your action')).toBeVisible({
          timeout: 60_000,
        });
      });
      await step('joiner', joinerPage, '11-submit-action', async () => {
        await joinerPage.getByLabel('Your action').fill('I watch the door.');
        await joinerPage.getByRole('button', { name: 'Send action' }).click();
        await expect
          .poll(
            () =>
              joinerView.frames.some(
                (frame) => frame.type === 'RoundActionAccepted',
              ),
            { timeout: 30_000 },
          )
          .toBe(true);
      });
    } finally {
      await Promise.all([closeAs(hostView), closeAs(joinerView)]);
    }
  });
});
