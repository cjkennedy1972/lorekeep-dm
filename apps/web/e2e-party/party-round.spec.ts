import { readFileSync } from 'node:fs';
import { expect, test, type Browser, type Page } from '@playwright/test';

// Real server + Postgres + scripted DM (see apps/server/test/live/serve.party.live.ts).
// Three browser contexts share one table; every round action goes through the real websocket.
type Account = { accountId: string; token: string };
type PartyState = {
  table: string;
  invite: string;
  host: Account;
  guest: Account;
  scout: Account;
  outsider: Account;
};
// Only the fields these specs read; every other frame field is ignored.
type ServerFrame = {
  type: string;
  payload?: {
    code?: string;
    text?: string;
    state?: { seats?: { displayName: string; chatMuted?: boolean }[] };
  };
};
const state = () =>
  JSON.parse(readFileSync(process.env.LIVE_STATE_FILE!, 'utf8')) as PartyState;
const origin = `http://localhost:${process.env.LIVE_WEB_PORT ?? 5176}`;

// Game.tsx:97 loads GET /api/tables/:id for the solo recap, and that route only resolves
// solo sessions owned by the caller (routes/tables.ts). A party table has no such row, so the
// real response is 404 and Game.tsx:483 replaces the whole screen with "Game unavailable".
// Only that recap request is answered here; round, host, chat and websocket traffic is real.
// Product gap reported on card 1ff75585-765c-49b4-b359-ad561747db7e.
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
  await context.route(`**/api/tables/${table}`, (route) =>
    route.fulfill({
      json: { game: { recap: '', name: 'Party table' } },
    }),
  );
  const page = await context.newPage();
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
  await page.goto(path);
  return { context, page, frames };
}

async function tabTo(page: Page, name: string) {
  for (let i = 0; i < 120; i += 1) {
    await page.keyboard.press('Tab');
    const focused = await page.evaluate(
      () => document.activeElement?.textContent?.trim() ?? '',
    );
    if (focused === name) return;
  }
  throw new Error(`could not reach "${name}" with Tab`);
}

test.describe.serial('party round and host panels (real server)', () => {
  test.setTimeout(180_000);

  // Blocked for the three round specs below: Room.clientState() deletes `round`
  // (Room.ts:569) and the once-per-subscribe RoundOpened snapshot (Room.ts:599-614) is never
  // stored by the client reducer (reducer.ts:56 assumes a StateSync carries the round). So
  // room.round stays undefined in Game.tsx and RoundPanel always says "No round is open.".
  // Card 1ff75585-765c-49b4-b359-ad561747db7e.

  test.fixme(
    'three seated players see one round and the same submitted list',
    async ({ browser }) => {
      const { table, host, guest, scout } = state();
      const path = `/rooms/${table}/game`;
      const players = [
        await openAs(browser, host, table, path),
        await openAs(browser, guest, table, path),
        await openAs(browser, scout, table, path),
      ];
      try {
        for (const { page } of players) {
          await expect(
            page.getByRole('heading', { name: 'Round' }),
          ).toBeVisible();
          await expect(page.locator('.round-summary')).toHaveText(
            /0 of 3 submitted\./,
            { timeout: 30_000 },
          );
          const submitted = page.getByRole('list', { name: 'Submitted' });
          await expect(
            submitted.getByText('Round Guest: waiting'),
          ).toBeVisible();
          await expect(
            submitted.getByText('Round Scout: waiting'),
          ).toBeVisible();
        }
      } finally {
        await Promise.all(players.map(({ context }) => context.close()));
      }
    },
  );

  test.fixme(
    'a player submits a round action and every player sees who has submitted',
    async ({ browser }) => {
      const { table, host, guest, scout } = state();
      const path = `/rooms/${table}/game`;
      const hostView = await openAs(browser, host, table, path);
      const guestView = await openAs(browser, guest, table, path);
      const scoutView = await openAs(browser, scout, table, path);
      try {
        await expect(guestView.page.locator('.round-summary')).toHaveText(
          /0 of 3 submitted\./,
          { timeout: 30_000 },
        );
        await guestView.page
          .getByLabel('Your action')
          .fill('I search the hall');
        await guestView.page
          .getByRole('button', { name: 'Send action' })
          .click();

        await expect(
          guestView.page.getByRole('heading', { name: 'Your action' }),
        ).toBeVisible();
        for (const { page } of [hostView, guestView, scoutView]) {
          await expect(page.locator('.round-summary')).toHaveText(
            /1 of 3 submitted\./,
            { timeout: 30_000 },
          );
          await expect(
            page
              .getByRole('list', { name: 'Submitted' })
              .getByText('Round Guest: submitted'),
          ).toBeVisible();
        }
      } finally {
        await Promise.all(
          [hostView, guestView, scoutView].map(({ context }) =>
            context.close(),
          ),
        );
      }
    },
  );

  test.fixme(
    'the host resolves the round from the keyboard alone',
    async ({ browser }) => {
      const { table, host, scout } = state();
      const path = `/rooms/${table}/game`;
      const hostView = await openAs(browser, host, table, path);
      const scoutView = await openAs(browser, scout, table, path);
      try {
        await expect(
          hostView.page.getByRole('heading', { name: 'Host controls' }),
        ).toBeVisible();
        await tabTo(hostView.page, 'Resolve round now');
        await hostView.page.keyboard.press('Enter');

        await expect(
          hostView.page
            .getByRole('status')
            .filter({ hasText: 'Round resolve requested.' }),
        ).toBeVisible();
        await expect(
          scoutView.page
            .getByRole('status')
            .filter({ hasText: 'The host resolved the round.' }),
        ).toBeVisible({ timeout: 60_000 });
      } finally {
        await Promise.all([
          hostView.context.close(),
          scoutView.context.close(),
        ]);
      }
    },
  );

  test('a late joiner is told the join is pending while a game is running', async ({
    browser,
  }) => {
    const { table, invite, outsider } = state();
    const { context, page } = await openAs(
      browser,
      outsider,
      table,
      `/join/${invite}`,
    );
    try {
      const rejected = page.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          new URL(response.url()).pathname === `/api/invites/${invite}/join`,
      );
      await page.getByRole('button', { name: 'Join table' }).click();
      const response = await rejected;
      expect(response.status()).toBe(409);
      expect(await response.json()).toMatchObject({
        code: 'LATE_JOIN_PENDING',
      });
      await expect(page.getByRole('alert').first()).not.toBeEmpty();
    } finally {
      await context.close();
    }
  });

  test('the host mutes a seat and its chat sends are refused', async ({
    browser,
  }) => {
    const { table, host, guest } = state();
    const path = `/rooms/${table}/game`;
    const hostView = await openAs(browser, host, table, path);
    const guestView = await openAs(browser, guest, table, path);
    try {
      // The mute controls render on each chat message, so the guest posts one first.
      await guestView.page
        .getByRole('textbox', { name: 'Message' })
        .fill('hello table');
      await guestView.page.getByRole('button', { name: 'Send chat' }).click();
      await expect(hostView.page.getByText('hello table')).toBeVisible({
        timeout: 30_000,
      });
      const muteGuest = hostView.page.getByRole('button', {
        name: 'Mute Round Guest in chat',
        exact: true,
      });
      await expect(muteGuest).toBeEnabled({ timeout: 30_000 });
      await muteGuest.click();

      // ChatMuteChanged only triggers a Resync (reducer.ts), so the muted flag reaches the
      // guest through the StateSync that the server sends back.
      await expect
        .poll(
          () =>
            guestView.frames.some(
              (frame) =>
                frame.type === 'StateSync' &&
                frame.payload?.state?.seats?.some(
                  (seat) =>
                    seat.displayName === 'Round Guest' &&
                    seat.chatMuted === true,
                ),
            ),
          { timeout: 30_000 },
        )
        .toBe(true);

      await guestView.page
        .getByRole('textbox', { name: 'Message' })
        .fill('can anyone hear me');
      await guestView.page.getByRole('button', { name: 'Send chat' }).click();
      await expect
        .poll(() => guestView.frames.some((frame) => frame.type === 'Error'), {
          timeout: 30_000,
        })
        .toBe(true);
      const rejection = guestView.frames.find(
        (frame) => frame.type === 'Error',
      );
      expect(rejection?.payload?.code).toBe('CHAT_REJECTED');
      expect(
        guestView.frames.some(
          (frame) =>
            frame.type === 'ChatMessage' &&
            frame.payload?.text === 'can anyone hear me',
        ),
      ).toBe(false);
    } finally {
      await Promise.all([hostView.context.close(), guestView.context.close()]);
    }
  });

  // Blocked: the client has no UI for these host commands. HostControls.tsx:27-31 lists
  // KickSeat, TransferHost, ApproveLateJoin, DenyLateJoin and EndTable as disabled
  // "Server support is not in place yet." rows, so no browser path can send them.
  // Card 1ff75585-765c-49b4-b359-ad561747db7e.
  test.fixme(
    'host kicks a seat and the kicked player loses access',
    async () => {},
  );
  test.fixme('host transfers host to another seat', async () => {});
  test.fixme('host approves a pending late join', async () => {});
  test.fixme('host denies a pending late join', async () => {});
  test.fixme('host ends the table', async () => {});
});
