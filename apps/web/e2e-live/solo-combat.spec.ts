import { readFileSync } from 'node:fs';
import { expect, test, type Locator } from '@playwright/test';

// Keyboard-only: this spec never uses the mouse. Controls are reached with
// focus() (the programmatic equivalent of tabbing to them) and operated with
// Enter / Space / Escape.
const state = () =>
  JSON.parse(readFileSync(process.env.LIVE_STATE_FILE!, 'utf8')) as {
    token: string;
    table: string;
    heroId: string;
  };

test('keyboard-only solo combat from start_combat to CombatEnded on the real recorded server', async ({
  page,
  context,
}) => {
  test.setTimeout(240_000);
  const { token, table, heroId } = state();
  await context.addCookies([
    { name: 'sid', value: token, url: 'http://localhost:5174' },
  ]);
  const consoleErrors: string[] = [];
  page.on(
    'console',
    (m) => m.type() === 'error' && consoleErrors.push(m.text()),
  );
  await page.goto(`/rooms/${table}/game`);

  // The DM is scripted: START-COMBAT makes it call start_combat.
  const action = page.getByLabel('Your action');
  await action.focus();
  await page.keyboard.type('START-COMBAT');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Send action' })).toBeFocused();
  await page.keyboard.press('Enter');

  await expect(page.getByRole('heading', { name: /^Round 1/ })).toBeVisible({
    timeout: 60_000,
  });
  const firstTracker = page
    .getByRole('list', { name: 'Initiative tracker' })
    .getByRole('listitem')
    .first();
  await expect(firstTracker).toHaveAttribute('aria-current', 'step');
  // Turn-start Describe announcement in a polite live region.
  const announce = page
    .locator('[aria-live="polite"]')
    .filter({ hasText: /feet movement remaining\. Threats within 30 feet/ });
  await expect(announce.first()).toBeVisible();

  const ended = page.getByText(/^CombatEnded:/);
  const steps: string[] = [];
  const activate = async (button: Locator, label: string) => {
    steps.push(label);
    await button.focus();
    await expect(button).toBeFocused();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(250);
  };
  for (let i = 0; i < 80 && !(await ended.isVisible()); i++) {
    // Opportunity-attack prompt: answer from the keyboard.
    const dialog = page.getByRole('dialog');
    if (await dialog.isVisible()) {
      await activate(
        dialog.getByRole('button', { name: 'Decline' }),
        'reaction:decline',
      );
      continue;
    }
    if (!(await page.getByText(`Active combatant: ${heroId}`).isVisible())) {
      await page.waitForTimeout(150);
      continue;
    }
    await activate(
      page.getByRole('button', { name: 'Refresh combat options' }),
      'options',
    );
    await page.waitForTimeout(400);
    const cast = page.getByRole('button', { name: /^Cast / }).first();
    const attack = page.getByRole('button', { name: /^Attack / }).first();
    if (await cast.isVisible()) {
      await activate(cast, `cast:${await cast.textContent()}`);
    } else if (await attack.isVisible()) {
      await activate(attack, `attack:${await attack.textContent()}`);
    } else {
      // Out of reach: step toward the nearest enemy with the offered move options.
      const target = await page.evaluate(() => {
        const at = (el: Element) => ({
          x: Number(el.getAttribute('data-x')),
          y: Number(el.getAttribute('data-y')),
        });
        const foes = [
          ...document.querySelectorAll('[aria-label="Combat tokens"] li'),
        ]
          .filter((t) => /goblin/.test(t.textContent ?? ''))
          .map(at);
        let best = -1;
        let bestD = Infinity;
        [...document.querySelectorAll('button')]
          .filter((b) => /^Move to /.test(b.textContent ?? ''))
          .forEach((b, n) => {
            const m = /Move to (\d+), (\d+)/.exec(b.textContent ?? '');
            if (!m) return;
            const d = Math.min(
              ...foes.map((f) =>
                Math.max(Math.abs(f.x - +m[1]!), Math.abs(f.y - +m[2]!)),
              ),
            );
            if (d < bestD) {
              bestD = d;
              best = n;
            }
          });
        return best;
      });
      if (target >= 0) {
        const move = page
          .getByRole('button', { name: /^Move to / })
          .nth(target);
        await activate(move, `move:${await move.textContent()}`);
        continue; // same turn: refresh options again
      }
    }
    await activate(page.getByRole('button', { name: 'End turn' }), 'end-turn');
  }
  await expect(ended).toBeVisible({ timeout: 30_000 });
  // The fight must have been played by the keyboard, not skipped.
  expect(steps.some((x) => /^(cast|attack):/.test(x))).toBe(true);
  expect(await ended.textContent()).toMatch(/^CombatEnded: party-victory$/);
  // The live sheet shows the seated character (it parses the server's character).
  await expect(page.getByText('No character selected.')).toHaveCount(0);
  const sheet = page.getByRole('region', { name: 'Aria' });
  await expect(sheet).toBeVisible();
  // Two Burning Hands casts spent both level-1 slots; the live sheet shows it.
  await expect(sheet).toContainText('Level 1: 0 of 2 remaining');
  expect(consoleErrors).toEqual([]);
});
