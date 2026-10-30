import { mkdirSync, readFileSync } from 'node:fs';
import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';
import { redactInviteUrls, safeUrl } from './redact';

// Real server + Postgres (see apps/server/test/live/serve.party.live.ts, the late-join table).
// Same flow as party-late-join-enter.spec.ts, asserting what the late joiner sees at each stage:
// the join request is waiting, the seat is approved and joining, and Enter game unlocks only once
// the seat is bound. Runs at 390px so the layout is checked on a phone-width viewport.
type Account = { accountId: string; token: string };
type LateJoinState = {
  lateJoinStages: {
    table: string;
    invite: string;
    host: Account;
    joiner: Account;
  };
};

const state = () =>
  JSON.parse(
    readFileSync(process.env.LIVE_STATE_FILE!, 'utf8'),
  ) as LateJoinState;
const origin = `http://localhost:${process.env.LIVE_WEB_PORT ?? 5176}`;
const shotDir =
  process.env.LATE_JOIN_SHOT_DIR ?? 'test-results/joiner-waiting-states';

async function openAs(browser: Browser, account: Account, path: string) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  await context.addCookies([
    { name: 'sid', value: account.token, url: origin },
  ]);
  await context.addInitScript(() => {
    localStorage.setItem('lorekeep.drawer.host', 'open');
    localStorage.removeItem('lorekeep.drawer.chat');
  });
  const page = await context.newPage();
  await page.goto(path).catch((error: unknown) => {
    throw new Error(redactInviteUrls(String(error)));
  });
  return { accountId: account.accountId, context, page };
}

async function closeAs(view: { context: BrowserContext }) {
  await view.context.close();
  await new Promise((resolve) => setTimeout(resolve, 100));
}

// Logs the step and saves a full-page screenshot, so a failure shows the exact stage it stopped at.
async function step(
  who: string,
  page: Page,
  name: string,
  run: () => Promise<void>,
) {
  console.log(
    `[joiner-states] START ${who}: ${name} url=${safeUrl(page.url())}`,
  );
  try {
    await run();
    console.log(`[joiner-states] OK    ${who}: ${name}`);
  } catch (error) {
    console.log(
      `[joiner-states] FAIL  ${who}: ${name} url=${safeUrl(page.url())}`,
    );
    throw error;
  } finally {
    const file = `${shotDir}/${who}-${name.replace(/\W+/g, '-')}.png`;
    mkdirSync(shotDir, { recursive: true });
    await page
      .screenshot({ path: file, fullPage: true })
      .catch(() => undefined);
  }
}

test.describe.serial('late joiner waiting states (real server, 390px)', () => {
  test.use({ actionTimeout: 10_000, expect: { timeout: 10_000 } });
  test.setTimeout(120_000);
  test.beforeEach(async ({ request }) => {
    const response = await request.post('/api/test/reset-auth-attempts');
    expect(response.ok()).toBe(true);
  });

  test('the joiner sees each waiting stage in order; Enter game unlocks only after binding', async ({
    browser,
  }) => {
    const { lateJoinStages } = state();
    const { table, invite, host, joiner } = lateJoinStages;
    const hostView = await openAs(browser, host, `/rooms/${table}/game`);
    const joinerView = await openAs(browser, joiner, `/join/${invite}`);
    const hostPage = hostView.page;
    const joinerPage = joinerView.page;
    const controls = hostPage.getByRole('region', { name: 'Host controls' });
    const enterButton = joinerPage.getByRole('button', {
      name: 'Enter game',
      exact: true,
    });
    const enterLink = joinerPage.getByRole('link', {
      name: 'Enter game',
      exact: true,
    });
    try {
      // Stage 1: the request is waiting for the host.
      await step('joiner', joinerPage, '1-request-waiting', async () => {
        const requested = joinerPage.waitForResponse(
          (response) =>
            response.request().method() === 'POST' &&
            new URL(response.url()).pathname === `/api/invites/${invite}/join`,
        );
        await joinerPage.getByRole('button', { name: 'Join table' }).click();
        expect((await requested).status()).toBe(409);
        await expect(joinerPage.getByRole('alert').first()).toContainText(
          'Your request is waiting for the host',
        );
      });

      // The host approves the request and resolves the round, which admits the seat.
      await step('host', hostPage, '2-approve-and-resolve', async () => {
        const approve = controls.getByRole('button', {
          name: /^Approve /,
          exact: false,
        });
        await expect(approve).toBeEnabled();
        await approve.click();
        const resolve = controls.getByRole('button', {
          name: 'Resolve round now',
          exact: true,
        });
        await expect(resolve).toBeEnabled();
        await resolve.click();
      });

      // Stage 2: the joiner retries and lands in the lobby, where Enter game is a disabled button.
      await step('joiner', joinerPage, '3-lobby-enter-locked', async () => {
        await joinerPage.getByRole('button', { name: 'Join table' }).click();
        await expect
          .poll(() => safeUrl(joinerPage.url()), { timeout: 60_000 })
          .toMatch(new RegExp(`/rooms/${table}$`));
        await expect(enterButton).toBeDisabled();
        await expect(enterLink).toHaveCount(0);
        await expect(
          joinerPage.getByText(/Available once your character is bound/),
        ).toBeVisible();
      });

      // Stage 3: the second approval, the device claim. The joiner is told it is waiting on the host.
      const claims = hostPage.getByRole('region', { name: 'Device claims' });
      const claimApprove = claims.getByRole('button', {
        name: 'Approve',
        exact: true,
      });
      const claimPending = joinerPage.getByText(
        'Approved by the host. Waiting for the host to confirm your device.',
      );
      const claimRequested = await claimPending
        .waitFor({ state: 'visible', timeout: 10_000 })
        .then(() => true)
        .catch(() => false);
      console.log(`[joiner-states] device claim shown=${claimRequested}`);
      if (claimRequested) {
        await step('joiner', joinerPage, '4-device-claim-pending', async () => {
          await expect(claimPending).toBeVisible();
          await expect(enterButton).toBeDisabled();
          await expect(
            joinerPage.getByText(/The host has \d+ seconds? to confirm\./),
          ).toBeVisible();
        });
        await step('host', hostPage, '5-host-sees-claim-badge', async () => {
          await expect(
            hostPage.getByRole('status').filter({
              hasText: 'is waiting to confirm a device',
            }),
          ).toBeVisible();
          await claimApprove.click();
        });
      }

      // Stage 4: seated, admitted, not yet bound. The lobby says the seat joins at the next round.
      await step('joiner', joinerPage, '6-seated-next-round', async () => {
        await expect(
          joinerPage.getByText(
            'You are in. Joining at the start of the next round.',
          ),
        ).toBeVisible({ timeout: 60_000 });
        await expect(enterButton).toBeDisabled();
        await expect(enterLink).toHaveCount(0);
      });

      // The joiner's snapshot ack is recorded after the round that admitted the seat, so binding
      // waits for the next round boundary: the host resolves again.
      await step('host', hostPage, '7-resolve-round-after-ack', async () => {
        const resolve = controls.getByRole('button', {
          name: 'Resolve round now',
          exact: true,
        });
        await expect(resolve).toBeEnabled({ timeout: 60_000 });
        await resolve.click();
      });

      // Stage 5: bind the preselected character. Only now does Enter game become a link.
      await step('joiner', joinerPage, '8-bound-enter-enabled', async () => {
        const bind = joinerPage.getByRole('button', {
          name: 'Bind character',
          exact: true,
        });
        if (await bind.isVisible({ timeout: 60_000 }).catch(() => false))
          await bind.click();
        await expect(enterLink).toBeVisible({ timeout: 60_000 });
        await expect(enterLink).toHaveAttribute('href', `/rooms/${table}/game`);
        await expect(enterButton).toHaveCount(0);
      });

      await step('joiner', joinerPage, '9-enter-game', async () => {
        await enterLink.click();
        await expect
          .poll(() => safeUrl(joinerPage.url()))
          .toMatch(new RegExp(`/rooms/${table}/game$`));
      });
    } finally {
      await Promise.all([closeAs(hostView), closeAs(joinerView)]);
    }
  });
});
