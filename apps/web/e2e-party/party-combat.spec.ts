import { expect, test, type Page } from '@playwright/test';
import {
  closeMember,
  openMember,
  readState,
  SYNC_BUDGET_MS,
  type View,
} from './combat-helpers.js';

// Real server + Postgres + scripted DM (see apps/server/test/live/serve.party.live.ts).
// The combat table's three members each sit in their own browser. Every move goes through the real
// websocket and is applied by the server. Keyboard only: no mouse and no locator clicks.

// The token li the server marks as the active combatant (data-active follows the initiative head).
const activeToken = (page: Page) =>
  page.locator('ul[aria-label="Combat tokens"] li[data-active="true"]');

test('three browsers: keyboard-only party move and cancel, synced to every seat within 1 s', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const { combat } = readState();
  const views: View[] = [];
  try {
    for (const member of [combat.host, combat.guest, combat.scout])
      views.push(await openMember(browser, member, combat.table));

    for (const { page } of views)
      await expect(
        page.getByRole('list', { name: 'Initiative tracker' }),
      ).toBeVisible({ timeout: 30_000 });

    // The server names the active combatant. It must be one of this table's party seats, bound to a
    // sheet, not an enemy, and the seat's browser must be the one that drives the move.
    const activeText = views[0]!.page.locator('.game-active');
    await expect(activeText).toBeVisible();
    const activeId = (
      (await activeText.getAttribute('data-entity-id')) ?? ''
    ).trim();
    const active = views.find((v) => v.member.entityId === activeId);
    expect(
      active,
      `active combatant ${activeId} is a party seat`,
    ).toBeDefined();
    const others = views.filter((v) => v !== active);

    const map = active!.page.getByRole('application', { name: 'Battle map' });
    await expect(map).toBeVisible();
    const start = {
      x: await activeToken(active!.page).getAttribute('data-x'),
      y: await activeToken(active!.page).getAttribute('data-y'),
    };

    // Cancel path: enter move mode, step the cursor, then Escape. The token must stay put.
    await map.focus();
    await active!.page.keyboard.press('Enter');
    await expect(map).toHaveAttribute('data-moving', 'true');
    await active!.page.keyboard.press('ArrowRight');
    await active!.page.keyboard.press('Escape');
    await expect(map).toHaveAttribute('data-moving', 'false');
    await expect(
      active!.page
        .locator('[aria-live="polite"]')
        .filter({ hasText: 'Movement cancelled.' }),
    ).toBeVisible();
    await expect(activeToken(active!.page)).toHaveAttribute('data-x', start.x!);
    await expect(activeToken(active!.page)).toHaveAttribute('data-y', start.y!);

    // Move path: step the cursor until the server reports a reachable path, then confirm with Enter.
    await map.focus();
    await active!.page.keyboard.press('Enter');
    await expect(map).toHaveAttribute('data-moving', 'true');
    const arrows = ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'];
    let reachable = false;
    for (let step = 0; step < 12 && !reachable; step += 1) {
      await active!.page.keyboard.press(arrows[step % arrows.length]!);
      reachable = await active!.page
        .locator('[aria-live="polite"]')
        .filter({ hasText: /Path cost \d+ feet\./ })
        .first()
        .isVisible();
    }
    expect(reachable, 'a reachable destination was found by keyboard').toBe(
      true,
    );

    // The cursor is the destination the server will receive.
    const target = {
      x: Number(await map.getAttribute('data-cursor-x')),
      y: Number(await map.getAttribute('data-cursor-y')),
    };
    const t0 = Date.now();
    await active!.page.keyboard.press('Enter');

    // Every browser, including the mover, must show the token at the target within the budget.
    await Promise.all(
      views.map(({ page }) =>
        page
          .locator(
            `ul[aria-label="Combat tokens"] li[data-active="true"][data-x="${target.x}"][data-y="${target.y}"]`,
          )
          .waitFor({ state: 'visible', timeout: SYNC_BUDGET_MS }),
      ),
    );
    const elapsed = Date.now() - t0;
    console.log(
      `party move sync: ${elapsed} ms to all ${views.length} browsers`,
    );
    expect(elapsed).toBeLessThanOrEqual(SYNC_BUDGET_MS);

    await expect(map).toHaveAttribute('data-moving', 'false');
    // Confirmation is not a turn end: the moved seat stays the active combatant.
    for (const { page } of others)
      await expect(
        page.locator(`.game-active[data-entity-id="${activeId}"]`),
      ).toBeVisible();
  } finally {
    for (const view of views) await closeMember(view);
  }
});
