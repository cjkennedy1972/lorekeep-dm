import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { script, twoPlayerTable } from './round-helpers';

test('round panel shows who has submitted, the time left, and why the round closed', async ({
  browser,
}) => {
  const t = await twoPlayerTable(browser, 'Round panel');
  try {
    await script(t.host, t.room, { op: 'open', deadlineInMs: 120_000 });
    const hostRound = t.hostPage.getByRole('region', { name: 'Round' });
    // Three eligible seats: host, guest, and the mock's scripted participant.
    await expect(hostRound.locator('.round-summary')).toHaveText(
      '0 of 3 submitted.',
    );
    await expect(hostRound.getByText('Time left:')).toBeVisible();
    await expect(hostRound.getByText('Round Host: waiting')).toBeVisible();
    await expect(hostRound.getByText('Round Guest: waiting')).toBeVisible();

    // The guest submits from the keyboard; the host's panel should follow.
    const guestRound = t.guestPage.getByRole('region', { name: 'Round' });
    await t.guestPage.getByLabel('Your action').fill('I look around.');
    await t.guestPage
      .getByRole('button', { name: 'Send action' })
      .press('Enter');
    await expect(guestRound.getByText('Round Guest: submitted')).toBeVisible();
    await expect(hostRound.getByText('Round Guest: submitted')).toBeVisible();
    await expect(hostRound.locator('.round-summary')).toHaveText(
      '1 of 3 submitted.',
    );

    await script(t.host, t.room, { op: 'close', reason: 'timer' });
    // The live region announces the count and the close reason once, not the countdown.
    await expect(
      hostRound.getByRole('status').filter({ hasText: 'The time ran out.' }),
    ).toHaveText('1 of 3 submitted. The time ran out.');
    await expect(
      guestRound.getByRole('button', { name: 'Edit action' }),
    ).toHaveCount(0);

    const results = await new AxeBuilder({ page: t.hostPage })
      .include('.round-panel')
      .analyze();
    const blocking = results.violations.filter((v) =>
      ['critical', 'serious'].includes(v.impact ?? ''),
    );
    expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);
  } finally {
    await Promise.all([t.host.close(), t.guest.close()]);
  }
});

test('an action sent while the round is closing is marked as queued', async ({
  browser,
}) => {
  const t = await twoPlayerTable(browser, 'Round queue');
  try {
    await script(t.host, t.room, { op: 'open', deadlineInMs: null });
    const hostRound = t.hostPage.getByRole('region', { name: 'Round' });
    await expect(hostRound.getByText('No time limit.')).toBeVisible();

    await script(t.host, t.room, { op: 'close', reason: 'timer' });
    const guestRound = t.guestPage.getByRole('region', { name: 'Round' });
    await t.guestPage.getByLabel('Your action').fill('A late thought.');
    await t.guestPage
      .getByRole('button', { name: 'Send action' })
      .press('Enter');
    await expect(
      guestRound.getByText(/Queued for the next round/),
    ).toBeVisible();
  } finally {
    await Promise.all([t.host.close(), t.guest.close()]);
  }
});
