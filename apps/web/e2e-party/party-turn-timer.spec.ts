import { readFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';

// Real server + Postgres (see apps/server/test/live/serve.party.live.ts). Host and guest share one table.
type Account = { accountId: string; token: string };
type PartyState = { table: string; host: Account; guest: Account };
type ServerFrame = {
  type: string;
  payload?: { durationMs?: number | null; timeoutAction?: string };
};
const state = () =>
  JSON.parse(readFileSync(process.env.LIVE_STATE_FILE!, 'utf8')) as PartyState;
const origin = `http://localhost:${process.env.LIVE_WEB_PORT ?? 5176}`;

async function openAs(browser: Browser, account: Account, table: string) {
  const context: BrowserContext = await browser.newContext();
  await context.addCookies([
    { name: 'sid', value: account.token, url: origin },
  ]);
  // The turn timer lives in the host tools drawer, which starts collapsed and remembers being opened.
  await context.addInitScript(() => {
    localStorage.setItem('lorekeep.drawer.host', 'open');
  });
  const page: Page = await context.newPage();
  const frames: ServerFrame[] = [];
  page.on('websocket', (socket) =>
    socket.on('framereceived', (event) => {
      if (typeof event.payload !== 'string') return;
      try {
        frames.push(JSON.parse(event.payload) as ServerFrame);
      } catch {
        // Non-JSON frames are not protocol messages; skip them.
      }
    }),
  );
  await page.goto(`/rooms/${table}/game`);
  await expect(
    page.getByRole('status').filter({ hasText: 'Connected to the room.' }),
  ).toBeVisible({ timeout: 30_000 });
  return { context, page, frames };
}

test.describe.serial('host turn timer control (real server)', () => {
  test.setTimeout(120_000);
  test.beforeEach(async ({ request }) => {
    const response = await request.post('/api/test/reset-auth-attempts');
    expect(response.ok()).toBe(true);
  });

  test('host sets the turn timer from the keyboard and the server confirms it', async ({
    browser,
  }) => {
    const { table, host } = state();
    const view = await openAs(browser, host, table);
    try {
      const { page } = view;
      const seconds = page.getByLabel(/Turn timer in seconds/);
      await seconds.fill('120');
      await page.getByRole('radio', { name: 'Hold' }).focus();
      await page.keyboard.press('Space');
      await page.getByRole('button', { name: 'Save turn timer' }).focus();
      await page.keyboard.press('Enter');

      await expect(
        page.getByRole('status').filter({
          hasText: 'Turn timer saved. It applies from the next turn opened.',
        }),
      ).toBeVisible();
      await expect
        .poll(() =>
          view.frames.some(
            (frame) =>
              frame.type === 'TurnTimerConfigured' &&
              frame.payload?.durationMs === 120_000 &&
              frame.payload?.timeoutAction === 'hold',
          ),
        )
        .toBe(true);
      await expect(page.getByText('120 seconds, then hold.')).toBeVisible();

      const results = await new AxeBuilder({ page })
        .include('.turn-timer')
        .analyze();
      expect(results.violations).toEqual([]);
    } finally {
      await view.context.close();
    }
  });

  test('a guest at the table does not see the turn timer control', async ({
    browser,
  }) => {
    const { table, guest } = state();
    const view = await openAs(browser, guest, table);
    try {
      await expect(
        view.page.getByRole('heading', { name: 'Turn timer' }),
      ).toHaveCount(0);
      await expect(view.page.getByLabel(/Turn timer in seconds/)).toHaveCount(
        0,
      );
    } finally {
      await view.context.close();
    }
  });
});
