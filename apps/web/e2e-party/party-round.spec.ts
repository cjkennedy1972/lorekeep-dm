import { readFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { mintSeatResume } from './seat-resume';
import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';

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
const storageByAccount = new Map<
  string,
  Awaited<ReturnType<BrowserContext['storageState']>>
>();

async function closeAs(view: { accountId: string; context: BrowserContext }) {
  storageByAccount.set(view.accountId, await view.context.storageState());
  await view.context.close();
  // Let the server-side close handler release the seat claim before the next serial spec reconnects.
  await new Promise((resolve) => setTimeout(resolve, 100));
}

// Every request goes to the real server; GET /api/tables/:id resolves party members (#280).
async function openAs(
  browser: Browser,
  account: Account,
  table: string,
  path: string,
  { drawers = true }: { drawers?: boolean } = {},
) {
  const savedStorage = storageByAccount.get(account.accountId);
  const context = await browser.newContext(
    savedStorage ? { storageState: savedStorage } : undefined,
  );
  if (!savedStorage) {
    await context.addCookies([
      { name: 'sid', value: account.token, url: origin },
    ]);
    await mintSeatResume(context, origin, table, account);
  }
  // Host tools and party chat are collapsed drawers that remember being opened; most specs drive them.
  await context.addInitScript((open) => {
    for (const id of ['host', 'chat'])
      if (open) localStorage.setItem(`lorekeep.drawer.${id}`, 'open');
      else localStorage.removeItem(`lorekeep.drawer.${id}`);
  }, drawers);
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
  if (new URL(path, origin).pathname.endsWith('/game'))
    await expect(
      page.getByRole('status').filter({ hasText: 'Connected to the room.' }),
    ).toBeVisible({ timeout: 30_000 });
  return { accountId: account.accountId, context, page, frames };
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
  test.beforeEach(async ({ request }) => {
    const response = await request.post('/api/test/reset-auth-attempts');
    expect(response.ok()).toBe(true);
  });

  test('three seated players see one round and the same submitted list', async ({
    browser,
  }) => {
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
        await expect(submitted.getByText('Round Guest: waiting')).toBeVisible();
        await expect(submitted.getByText('Round Scout: waiting')).toBeVisible();
      }
    } finally {
      for (const { accountId, context } of players) {
        const saved = await context.storageState();
        storageByAccount.set(accountId, saved);
      }
      await Promise.all(players.map(closeAs));
    }
  });

  test('host tools and party chat start collapsed and open from the keyboard; axe is clean with them open', async ({
    browser,
  }) => {
    const { table, host } = state();
    const view = await openAs(browser, host, table, `/rooms/${table}/game`, {
      drawers: false,
    });
    try {
      const { page } = view;
      const hostTools = page.locator('details.drawer', {
        has: page.getByText('Host tools', { exact: true }),
      });
      const chat = page.locator('details.drawer', {
        has: page.getByText('Party chat', { exact: true }),
      });
      await expect(hostTools).not.toHaveAttribute('open', '');
      await expect(chat).not.toHaveAttribute('open', '');
      await expect(
        page.getByRole('region', { name: 'Host controls' }),
      ).toBeHidden();
      // Safety stays one click away, never collapsed.
      await expect(
        page.getByRole('button', { name: 'X-card (anonymous)' }),
      ).toBeVisible();
      await hostTools.locator('summary').focus();
      await page.keyboard.press('Enter');
      await expect(
        page.getByRole('region', { name: 'Host controls' }),
      ).toBeVisible();
      await chat.locator('summary').focus();
      await page.keyboard.press('Space');
      await expect(
        page.getByRole('button', { name: 'Send chat' }),
      ).toBeVisible();
      for (const colorScheme of ['dark', 'light'] as const) {
        await page.emulateMedia({ colorScheme });
        const { violations } = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze();
        expect(
          violations
            .filter((v) => v.impact === 'critical' || v.impact === 'serious')
            .map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(' | ')}`),
          colorScheme,
        ).toEqual([]);
      }
    } finally {
      await closeAs(view);
    }
  });

  test('a player submits a round action and every player sees who has submitted', async ({
    browser,
  }) => {
    const { table, host, guest, scout } = state();
    const path = `/rooms/${table}/game`;
    const hostView = await openAs(browser, host, table, path);
    const resumeButton = hostView.page.getByRole('button', {
      name: 'Resume table',
    });
    const hostRound = hostView.page.locator('.round-summary');
    await expect
      .poll(
        async () =>
          (await resumeButton.isVisible()) || (await hostRound.isVisible()),
      )
      .toBe(true);
    if (await resumeButton.isVisible()) {
      await expect(resumeButton).toBeEnabled();
      await resumeButton.click();
      await expect(hostRound).toBeVisible();
    }
    let guestView = await openAs(browser, guest, table, path);
    const scoutView = await openAs(browser, scout, table, path);
    try {
      await expect(guestView.page.locator('.round-summary')).toHaveText(
        /0 of 3 submitted\./,
        { timeout: 30_000 },
      );
      await guestView.page.getByLabel('Your action').fill('I search the hall');
      await guestView.page.getByRole('button', { name: 'Send action' }).click();

      await expect(
        guestView.page.getByRole('heading', { name: 'Your action' }),
      ).toBeVisible();
      for (const view of [hostView, guestView, scoutView]) {
        await expect(view.page.locator('.round-summary')).toHaveText(
          /1 of 3 submitted\./,
          { timeout: 30_000 },
        );
        await expect(
          view.page
            .getByRole('list', { name: 'Submitted' })
            .getByText('Round Guest: submitted'),
        ).toBeVisible();
      }
      for (const view of [hostView, scoutView])
        await expect(
          view.page.getByText('I search the hall', { exact: true }),
        ).toHaveCount(0);
      await closeAs(guestView);
      guestView = await openAs(browser, guest, table, path);
      await expect(
        guestView.page.getByRole('heading', { name: 'Your action' }),
      ).toBeVisible();
      await guestView.page.getByRole('button', { name: 'Edit action' }).click();
      await expect(guestView.page.getByLabel('Edit your action')).toHaveValue(
        'I search the hall',
      );
    } finally {
      await Promise.all([hostView, guestView, scoutView].map(closeAs));
    }
  });

  test('the host resolves the round from the keyboard alone', async ({
    browser,
  }) => {
    const { table, host, scout } = state();
    const path = `/rooms/${table}/game`;
    const hostView = await openAs(browser, host, table, path);
    const scoutView = await openAs(browser, scout, table, path);
    try {
      await expect(
        hostView.page.getByRole('heading', { name: 'Host controls' }),
      ).toBeVisible();
      await expect(
        scoutView.page.getByRole('status').filter({
          hasText: 'Connected to the room.',
        }),
      ).toBeVisible();
      const resume = hostView.page.getByRole('button', {
        name: 'Resume table',
      });
      if (await resume.isVisible()) {
        await expect(resume).toBeEnabled();
        await resume.click();
        await expect(resume).toBeHidden();
      }
      await tabTo(hostView.page, 'Resolve round now');
      await hostView.page.keyboard.press('Enter');

      await expect(
        hostView.page
          .getByRole('status')
          .filter({ hasText: 'Round resolve requested.' }),
      ).toBeVisible();
      await expect
        .poll(() =>
          scoutView.frames.some((frame) => frame.type === 'RoundClosing'),
        )
        .toBe(true);
      await expect(
        scoutView.page
          .getByRole('status')
          .filter({ hasText: 'The host resolved the round.' }),
      ).toBeVisible({ timeout: 60_000 });
    } finally {
      await Promise.all([closeAs(hostView), closeAs(scoutView)]);
    }
  });

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
      await closeAs({ accountId: outsider.accountId, context });
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
      await Promise.all([closeAs(hostView), closeAs(guestView)]);
    }
  });

  // Host commands go through the real websocket. The describe block is serial, so each test
  // starts from the seating the earlier ones leave: kick Scout, hand host to Guest, then deny and
  // approve Latecomer as the new host, and end the table last.
  test('host kicks a seat and the kicked player loses access', async ({
    browser,
  }) => {
    const { table, host, scout } = state();
    const path = `/rooms/${table}/game`;
    const hostView = await openAs(browser, host, table, path);
    const scoutView = await openAs(browser, scout, table, path);
    try {
      const controls = hostView.page.getByRole('region', {
        name: 'Host controls',
      });
      await controls
        .getByRole('button', { name: 'Remove Round Scout', exact: true })
        .click();
      await hostView.page
        .getByRole('alertdialog')
        .getByRole('button', { name: 'Remove player', exact: true })
        .click();

      await expect(
        scoutView.page.getByRole('heading', { name: 'Removed from table' }),
      ).toBeVisible({ timeout: 30_000 });
      await expect(
        controls.getByRole('button', {
          name: 'Remove Round Scout',
          exact: true,
        }),
      ).toHaveCount(0);

      // Access is revoked server-side too: a fresh request for the table is refused.
      const reload = await scoutView.context.request.get(
        `/api/tables/${table}`,
      );
      expect(reload.ok()).toBe(false);
    } finally {
      await Promise.all([closeAs(hostView), closeAs(scoutView)]);
    }
  });

  test('host transfers host to another seat', async ({ browser }) => {
    const { table, host, guest } = state();
    const path = `/rooms/${table}/game`;
    const hostView = await openAs(browser, host, table, path);
    const guestView = await openAs(browser, guest, table, path);
    try {
      const hostControls = hostView.page.getByRole('region', {
        name: 'Host controls',
      });
      await hostControls
        .getByRole('button', { name: 'Make Round Guest host', exact: true })
        .click();
      await hostView.page
        .getByRole('alertdialog')
        .getByRole('button', { name: 'Make host', exact: true })
        .click();

      // The new host gets the controls; the old host loses them.
      await expect(
        guestView.page.getByRole('region', { name: 'Host controls' }),
      ).toBeVisible({ timeout: 30_000 });
      await expect(
        hostView.page.getByRole('region', { name: 'Host controls' }),
      ).toHaveCount(0, { timeout: 30_000 });
    } finally {
      await Promise.all([closeAs(hostView), closeAs(guestView)]);
    }
  });

  test('host denies a pending late join', async ({ browser }) => {
    const { table, invite, outsider, guest } = state();
    const path = `/rooms/${table}/game`;
    const hostView = await openAs(browser, guest, table, path);
    const latecomer = await openAs(browser, outsider, table, `/join/${invite}`);
    try {
      const pending = latecomer.page.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          new URL(response.url()).pathname === `/api/invites/${invite}/join`,
      );
      await latecomer.page.getByRole('button', { name: 'Join table' }).click();
      expect((await pending).status()).toBe(409);

      const controls = hostView.page.getByRole('region', {
        name: 'Host controls',
      });
      await controls.getByRole('button', { name: /^Deny / }).click();
      await expect(
        controls.getByRole('button', { name: /^Deny / }),
      ).toHaveCount(0, { timeout: 30_000 });

      // A denied request never seats the player, so the table stays closed to them.
      const access = await latecomer.context.request.get(
        `/api/tables/${table}`,
      );
      expect(access.ok()).toBe(false);
    } finally {
      await Promise.all([closeAs(hostView), closeAs(latecomer)]);
    }
  });

  // ApproveLateJoin only marks the request approved; admission to a seat happens at a round
  // boundary (Room.ts:1930 admitApprovedLateJoins). So the host resolves the open round after
  // approving, and the latecomer is seated.
  test('host approves a pending late join and the player is seated', async ({
    browser,
  }) => {
    const { table, invite, outsider, guest } = state();
    const path = `/rooms/${table}/game`;
    const hostView = await openAs(browser, guest, table, path);
    const latecomer = await openAs(browser, outsider, table, `/join/${invite}`);
    try {
      const pending = latecomer.page.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          new URL(response.url()).pathname === `/api/invites/${invite}/join`,
      );
      await latecomer.page.getByRole('button', { name: 'Join table' }).click();
      expect((await pending).status()).toBe(409);

      const controls = hostView.page.getByRole('region', {
        name: 'Host controls',
      });
      const approve = controls.getByRole('button', {
        name: /^Approve /,
        exact: true,
      });
      await expect(approve).toBeEnabled({ timeout: 10_000 });
      await approve.click();
      const resolve = controls.getByRole('button', {
        name: 'Resolve round now',
        exact: true,
      });
      const reconnectPause = hostView.page.getByRole('status').filter({
        hasText: 'Table paused: waiting for players to reconnect.',
      });
      await expect
        .poll(
          async () =>
            (await reconnectPause.isVisible()) || (await resolve.isEnabled()),
          { timeout: 15_000 },
        )
        .toBe(true);
      if (await reconnectPause.isVisible())
        await expect(reconnectPause).toBeHidden({ timeout: 20_000 });
      await expect(resolve).toBeEnabled({ timeout: 20_000 });
      await resolve.click();

      // Seated players appear in the host's seat list; the approved latecomer is one of them.
      await expect(
        controls.getByRole('button', {
          name: 'Remove Latecomer',
          exact: true,
        }),
      ).toBeVisible({ timeout: 30_000 });
      const access = await latecomer.context.request.get(
        `/api/tables/${table}`,
      );
      expect(access.ok()).toBe(true);
    } finally {
      await Promise.all([closeAs(hostView), closeAs(latecomer)]);
    }
  });

  // Gated on owner confirmation of the connected-client Not-seated presentation; generic HTTP 404 behavior is covered separately.
  test.fixme(
    'an unseated player sees Not seated and can rejoin',
    async () => {},
  );

  test('host ends the table and every seated player sees it ended', async ({
    browser,
  }) => {
    // Its own table: ending it closes the room for everyone in it.
    const { table, host, guest } = state().endTable;
    const path = `/rooms/${table}/game`;
    const hostView = await openAs(browser, host, table, path);
    const seatedView = await openAs(browser, guest, table, path);
    try {
      for (const view of [hostView, seatedView])
        await expect(
          view.page.getByRole('status').filter({
            hasText: 'Connected to the room.',
          }),
        ).toBeVisible();
      await hostView.page
        .getByRole('button', { name: 'End the table', exact: true })
        .click();
      await hostView.page
        .getByRole('alertdialog')
        .getByRole('button', { name: 'End table', exact: true })
        .click();

      await expect(
        seatedView.page.getByRole('heading', { name: 'Table ended' }),
      ).toBeVisible({ timeout: 30_000 });
      await expect(
        hostView.page.getByRole('heading', { name: 'Table ended' }),
      ).toBeVisible({ timeout: 30_000 });
    } finally {
      await Promise.all([closeAs(hostView), closeAs(seatedView)]);
    }
  });
});
