import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { script, sent, twoPlayerTable } from './round-helpers';

test('host pauses and resumes the table from the keyboard', async ({
  browser,
}) => {
  const t = await twoPlayerTable(browser, 'Host pause');
  try {
    const page = t.hostPage;
    await page.getByRole('button', { name: 'Pause table' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByText('The table is paused.')).toBeVisible();
    await expect
      .poll(() => sent(t.hostFrames, 'PauseTable', { paused: true }))
      .toBe(true);

    await page.getByRole('button', { name: 'Resume table' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByText('The table is active.')).toBeVisible();
    await expect
      .poll(() => sent(t.hostFrames, 'PauseTable', { paused: false }))
      .toBe(true);
  } finally {
    await Promise.all([t.host.close(), t.guest.close()]);
  }
});

test('resolve-now is disabled while paused, and the host controls pass axe', async ({
  browser,
}) => {
  const t = await twoPlayerTable(browser, 'Host resolve');
  try {
    await script(t.host, t.room, { op: 'open', deadlineInMs: null });
    const page = t.hostPage;
    const resolve = page.getByRole('button', { name: 'Resolve round now' });
    await expect(resolve).toBeEnabled();

    await page.getByRole('button', { name: 'Pause table' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByText('The table is paused.')).toBeVisible();
    await expect(resolve).toBeDisabled();
    await expect(
      page.getByText('Resume the table to resolve the round.'),
    ).toBeVisible();

    await page.getByRole('button', { name: 'Resume table' }).focus();
    await page.keyboard.press('Enter');
    await expect(resolve).toBeEnabled();

    const results = await new AxeBuilder({ page })
      .include('.round-panel')
      .include('.host-controls')
      .analyze();
    const blocking = results.violations.filter((v) =>
      ['critical', 'serious'].includes(v.impact ?? ''),
    );
    expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);
  } finally {
    await Promise.all([t.host.close(), t.guest.close()]);
  }
});

test('round timer clamps to 600 seconds and can be turned off', async ({
  browser,
}) => {
  const t = await twoPlayerTable(browser, 'Host timer');
  try {
    const page = t.hostPage;
    const controls = page.getByRole('region', { name: 'Host controls' });
    const timer = controls.getByLabel('Round timer in seconds (30 to 600)');

    await controls.getByLabel('No time limit').uncheck();
    await timer.fill('9999');
    await controls.getByRole('button', { name: 'Save round timer' }).focus();
    await page.keyboard.press('Enter');
    await expect(
      controls.getByRole('status').filter({ hasText: '600 seconds' }),
    ).toBeVisible();
    await expect
      .poll(() =>
        sent(t.hostFrames, 'ConfigureRoundTimer', { durationMs: 600_000 }),
      )
      .toBe(true);

    await controls.getByLabel('No time limit').check();
    await expect(timer).toBeDisabled();
    await controls.getByRole('button', { name: 'Save round timer' }).focus();
    await page.keyboard.press('Enter');
    await expect(
      controls.getByRole('status').filter({ hasText: 'Round timer saved.' }),
    ).toBeVisible();
    await expect
      .poll(() =>
        sent(t.hostFrames, 'ConfigureRoundTimer', { durationMs: null }),
      )
      .toBe(true);
  } finally {
    await Promise.all([t.host.close(), t.guest.close()]);
  }
});

test('host can request a rewind from the keyboard', async ({ browser }) => {
  const t = await twoPlayerTable(browser, 'Host rewind');
  try {
    const page = t.hostPage;
    await page.getByRole('button', { name: 'Rewind last turn' }).focus();
    await page.keyboard.press('Enter');
    await expect(
      page.getByText('Rewind requested for the last turn.'),
    ).toBeVisible();
    await expect.poll(() => sent(t.hostFrames, 'RewindTurn')).toBe(true);
  } finally {
    await Promise.all([t.host.close(), t.guest.close()]);
  }
});

test('host mutes and unmutes a guest in party chat', async ({ browser }) => {
  const t = await twoPlayerTable(browser, 'Host mute');
  try {
    await t.guestPage
      .getByRole('form', { name: 'Send party chat message' })
      .getByLabel('Message')
      .fill('Hello table');
    await t.guestPage.getByRole('button', { name: 'Send chat' }).press('Enter');
    await expect(
      t.hostPage.getByLabel('Party chat messages').getByText('Hello table'),
    ).toBeVisible();

    // exact: the unmute label contains this text, so a substring match finds both.
    const mute = t.hostPage.getByRole('button', {
      name: 'Mute Round Guest in chat',
      exact: true,
    });
    await mute.focus();
    await t.hostPage.keyboard.press('Enter');
    await expect
      .poll(() => sent(t.hostFrames, 'MuteChat', { muted: true }))
      .toBe(true);
    const unmute = t.hostPage.getByRole('button', {
      name: 'Unmute Round Guest in chat',
    });
    await unmute.focus();
    await t.hostPage.keyboard.press('Enter');
    await expect
      .poll(() => sent(t.hostFrames, 'MuteChat', { muted: false }))
      .toBe(true);
  } finally {
    await Promise.all([t.host.close(), t.guest.close()]);
  }
});
