import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser } from '@playwright/test';
import {
  activeCombatantId,
  closeMember,
  openMember,
  readState,
  SYNC_BUDGET_MS,
  tabTo,
  tokenTable,
  type View,
} from './combat-helpers.js';

// Keyboard-only party combat on the real server (see serve.party.live.ts). No mouse and no locator clicks
// for gameplay. All steps share one connected session. Seats are closed with closeMember, which keeps each
// seat's resume token, so specs that run later in the same server boot reconnect their seats (see
// combat-helpers.ts). Each step is a `test.step` so failures name the step.

const ARROWS = ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'] as const;

async function openCombatTable(browser: Browser) {
  const { combat } = readState();
  const views: View[] = [];
  for (const member of [combat.host, combat.guest, combat.scout])
    views.push(await openMember(browser, member, combat.table));
  for (const { page } of views)
    await expect(
      page.getByRole('list', { name: 'Initiative tracker' }),
    ).toBeVisible({ timeout: 30_000 });
  return views;
}

function findActive(views: View[], activeId: string): View {
  const active = views.find((v) => v.member.entityId === activeId);
  expect(active, `active combatant ${activeId} is a party seat`).toBeDefined();
  return active!;
}

test('party keyboard-only combat: focus, move (cancel and confirm), list and description, axe, mobile', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const views = await openCombatTable(browser);
  try {
    const activeId = await activeCombatantId(views[0]!.page);
    const active = findActive(views, activeId);
    const others = views.filter((v) => v !== active);
    const { page } = active;
    const map = page.getByRole('application', { name: 'Battle map' });
    const activeToken = page.locator(
      'ul[aria-label="Combat tokens"] li[data-active="true"]',
    );

    await test.step('keyboard reaches the battlefield controls with a visible focus ring', async () => {
      await tabTo(page, 'Describe battlefield (Alt+D)');
      await tabTo(page, 'Sort by distance');
      await expect(map).toBeVisible();
    });

    await test.step('move cancel: Enter starts move, Escape leaves the token in place', async () => {
      const start = {
        x: await activeToken.getAttribute('data-x'),
        y: await activeToken.getAttribute('data-y'),
      };
      await map.focus();
      await page.keyboard.press('Enter');
      await expect(map).toHaveAttribute('data-moving', 'true');
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('Escape');
      await expect(map).toHaveAttribute('data-moving', 'false');
      await expect(
        page
          .locator('[aria-live="polite"]')
          .filter({ hasText: 'Movement cancelled.' }),
      ).toBeVisible();
      await expect(activeToken).toHaveAttribute('data-x', start.x!);
      await expect(activeToken).toHaveAttribute('data-y', start.y!);
    });

    await test.step('move confirm: preview reports a path, Enter sends it, every seat syncs within the budget', async () => {
      await map.focus();
      await page.keyboard.press('Enter');
      await expect(map).toHaveAttribute('data-moving', 'true');
      const pathLine = page
        .locator('[aria-live="polite"]')
        .filter({ hasText: /Path cost \d+ feet\./ })
        .first();
      let reachable = false;
      for (let step = 0; step < 12 && !reachable; step += 1) {
        await page.keyboard.press(ARROWS[step % ARROWS.length]!);
        reachable = await pathLine.isVisible();
      }
      expect(reachable, 'a reachable destination was found by keyboard').toBe(
        true,
      );

      const target = {
        x: Number(await map.getAttribute('data-cursor-x')),
        y: Number(await map.getAttribute('data-cursor-y')),
      };
      // Timing starts at the keypress that sends the move and stops when each browser shows the token there.
      const t0 = Date.now();
      await page.keyboard.press('Enter');
      await Promise.all(
        views.map(({ page: p }) =>
          p
            .locator(
              `ul[aria-label="Combat tokens"] li[data-active="true"][data-x="${target.x}"][data-y="${target.y}"]`,
            )
            .waitFor({ state: 'visible', timeout: SYNC_BUDGET_MS }),
        ),
      );
      const elapsed = Date.now() - t0;
      console.log(
        `party keyboard move sync: ${elapsed} ms to all ${views.length} browsers`,
      );
      expect(elapsed).toBeLessThanOrEqual(SYNC_BUDGET_MS);
      await expect(map).toHaveAttribute('data-moving', 'false');
      // Confirming a move does not end the turn.
      for (const { page: p } of others)
        await expect(
          p.getByText(`Active combatant: ${activeId}`),
        ).toBeVisible();
    });

    await test.step('list-driven: the token table gives the same coordinates the map uses', async () => {
      const tokens = await tokenTable(page);
      expect(tokens.length, 'token table lists every token').toBeGreaterThan(0);
      const self = tokens.find((t) => t.id === active.member.entityId);
      expect(self, 'active seat appears in the table').toBeDefined();
      await expect(activeToken).toHaveAttribute('data-x', String(self!.x));
      await expect(activeToken).toHaveAttribute('data-y', String(self!.y));
    });

    await test.step('battlefield description opens from the keyboard alone (Alt+D)', async () => {
      await page.keyboard.press('Alt+d');
      await expect(
        page.locator('section[aria-label="Battlefield description"]'),
      ).toBeVisible();
    });

    await test.step('combat screen has no serious or critical axe violations', async () => {
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      const blocking = results.violations.filter(
        (v) => v.impact === 'critical' || v.impact === 'serious',
      );
      expect(
        blocking.map((v) => `${v.id} (${v.impact}): ${v.nodes.length} node(s)`),
        'no serious/critical axe violations on the combat screen',
      ).toEqual([]);
    });

    await test.step('mobile viewport (390x844): the map stays reachable from the keyboard', async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      const showMap = page.getByRole('button', { name: /^(Show|Hide) map$/ });
      await expect(showMap).toBeVisible();
      await tabTo(page, (await showMap.textContent())!.trim());
      await page.keyboard.press('Enter');
      await expect(map).toBeVisible();
    });
  } finally {
    for (const view of views) await closeMember(view);
  }
});
