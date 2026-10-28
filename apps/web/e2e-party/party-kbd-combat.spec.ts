import AxeBuilder from '@axe-core/playwright';
import {
  expect,
  test,
  type APIRequestContext,
  type Browser,
} from '@playwright/test';
import {
  activeCombatantId,
  closeMember,
  displayNameOf,
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

// The attacker's RollEvents from the server's CombatEvents frames. Attack rolls are not drawn in the
// narration log (only saves are), so the websocket frame is the observable for a resolved attack.
function attackerRolls(frames: unknown[], attackerId: string) {
  return frames
    .flatMap((frame) => {
      const { type, payload } = frame as {
        type?: string;
        payload?: { events?: unknown[] };
      };
      return type === 'CombatEvents' ? (payload?.events ?? []) : [];
    })
    .filter((event) => {
      const roll = event as { type?: string; actorId?: string };
      return roll.type === 'RollEvent' && roll.actorId === attackerId;
    });
}

// Restores the pristine combat board first: party-combat.spec.ts runs earlier in the same boot and changes it.
async function openCombatTable(browser: Browser, request: APIRequestContext) {
  const res = await request.post('/api/test/reset-combat');
  expect(res.ok(), `reset-combat: ${res.status()}`).toBe(true);
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
  request,
}) => {
  test.setTimeout(240_000);
  const views = await openCombatTable(browser, request);
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
      // The token table renders before the Describe panel in the DOM, so Tab reaches Sort first.
      await tabTo(page, 'Sort by distance');
      await tabTo(page, 'Describe battlefield (Alt+D)');
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

    await test.step('attack: the goblin in reach is attacked from the action list alone', async () => {
      // Fixture: the board is reset above, and the goblin is placed beside whichever entity acts first, so
      // it is in reach. Adjacency is asserted, not assumed, so a fixture change fails here with the positions.
      const goblin = 'ent_goblin-minion_1';
      const goblinToken = (await tokenTable(page)).find((t) => t.id === goblin);
      expect(goblinToken, 'goblin is on the battlefield').toBeDefined();
      const start = {
        x: Number(await activeToken.getAttribute('data-x')),
        y: Number(await activeToken.getAttribute('data-y')),
      };
      expect(
        Math.max(
          Math.abs(goblinToken!.x - start.x),
          Math.abs(goblinToken!.y - start.y),
        ),
        'goblin is adjacent to the active seat',
      ).toBe(1);
      // Options are sent on request: the keyboard requests them, then the list offers the attack.
      await tabTo(page, 'Refresh combat options');
      await page.keyboard.press('Enter');
      // Attack buttons carry the target's display name, not its entity id: read it from the tracker entry.
      const goblinName = await displayNameOf(page, goblin);
      // The name gains " with <Weapon>" when the goblin has several attacks, so match the prefix and tab to the exact name.
      const attacks = page.getByRole('button', {
        name: new RegExp(
          `^Attack ${goblinName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
        ),
      });
      await expect(attacks.first()).toBeVisible();
      const attackName = (await attacks.first().textContent())?.trim() ?? '';
      const framesBefore = active.frames.length;
      await tabTo(page, attackName, 200);
      await page.keyboard.press('Enter');
      // The server resolves the attack and pushes its RollEvent for the attacking seat.
      await expect
        .poll(
          () =>
            attackerRolls(active.frames.slice(framesBefore), activeId).length,
          { timeout: SYNC_BUDGET_MS * 5 },
        )
        .toBeGreaterThan(0);
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
          p.locator(`.game-active[data-entity-id="${activeId}"]`),
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
