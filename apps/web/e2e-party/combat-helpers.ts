import { readFileSync } from 'node:fs';
import {
  expect,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';

// Shared by the party combat specs. The state file is written by apps/server/test/live/serve.party.live.ts.
export type Member = { accountId: string; token: string; entityId: string };
export type CombatState = {
  combat: { table: string; invite: string } & Record<
    'host' | 'guest' | 'scout',
    Member
  >;
};
export type View = { member: Member; context: BrowserContext; page: Page };

export const readState = () =>
  JSON.parse(readFileSync(process.env.LIVE_STATE_FILE!, 'utf8')) as CombatState;
export const origin = `http://localhost:${process.env.LIVE_WEB_PORT ?? 5176}`;
// The sync budget from the party acceptance criteria: a move must reach every other browser within 1 s.
export const SYNC_BUDGET_MS = 1000;

export async function openMember(
  browser: Browser,
  member: Member,
  table: string,
  viewport?: { width: number; height: number },
): Promise<View> {
  const context = await browser.newContext(viewport ? { viewport } : {});
  await context.addCookies([{ name: 'sid', value: member.token, url: origin }]);
  const page = await context.newPage();
  await page.goto(`${origin}/rooms/${table}/game`);
  return { member, context, page };
}

/** The tracker's first entry is the active combatant; the server names it in the "Active combatant:" line. */
export async function activeCombatantId(page: Page): Promise<string> {
  const line = page.getByText(/^Active combatant: /);
  await expect(line).toBeVisible();
  return ((await line.textContent()) ?? '')
    .replace('Active combatant: ', '')
    .trim();
}

/**
 * Keyboard-only focus: press Tab until the focused element's accessible label is `name`, then assert
 * that the focus indicator is drawn (a non-none outline of at least 2 px). Fails if focus never arrives.
 */
export async function tabTo(page: Page, name: string, maxTabs = 120) {
  for (let presses = 0; presses <= maxTabs; presses += 1) {
    const focused = await page.evaluate((wanted) => {
      const el = document.activeElement as HTMLElement | null;
      if (!el) return false;
      const label = (
        el.getAttribute('aria-label') ??
        el.textContent ??
        ''
      ).trim();
      return label === wanted;
    }, name);
    if (focused) {
      const ring = await page.evaluate(() => {
        const style = getComputedStyle(document.activeElement as HTMLElement);
        return {
          outline: style.outlineStyle,
          width: parseFloat(style.outlineWidth),
        };
      });
      expect(ring.outline, `focus ring drawn on "${name}"`).not.toBe('none');
      expect(
        ring.width,
        `focus ring width on "${name}"`,
      ).toBeGreaterThanOrEqual(2);
      return;
    }
    await page.keyboard.press('Tab');
  }
  throw new Error(`keyboard focus never reached "${name}"`);
}

/** Map cells from the token table: "B3" is column B, row 3 (the coordinates the screen reader hears). */
export async function tokenTable(page: Page) {
  const rows = page.locator(
    'section[aria-label="Tokens and terrain"] tbody tr',
  );
  const count = await rows.count();
  const tokens: { id: string; kind: string; x: number; y: number }[] = [];
  for (let i = 0; i < count; i += 1) {
    const row = rows.nth(i);
    const id = ((await row.locator('th').textContent()) ?? '').trim();
    const cells = await row.locator('td').allTextContents();
    const match = /^([A-Z]+)(\d+)$/.exec(cells[1]?.trim() ?? '');
    if (!match) continue;
    tokens.push({
      id,
      kind: cells[0]!.trim(),
      x: match[1]!.charCodeAt(0) - 65,
      y: Number(match[2]) - 1,
    });
  }
  return tokens;
}
