import { readFileSync } from 'node:fs';
import {
  expect,
  type APIRequestContext,
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
  // The reaction table: its own encounter, used only by party-kbd-reaction.spec.ts.
  reaction: { table: string; invite: string } & Record<
    'host' | 'guest' | 'scout',
    Member
  >;
  // The area table: a caster PC with Burning Hands prepared, acting first. Used by the area and pointer specs.
  area: { table: string; invite: string } & Record<
    'caster' | 'guest' | 'scout',
    Member
  >;
};
/**
 * `frames` holds every JSON frame the server pushed to this page, in arrival order. `sent` holds every
 * JSON frame this page sent, so a spec can assert what the browser actually submitted.
 */
export type View = {
  member: Member;
  context: BrowserContext;
  page: Page;
  frames: unknown[];
  sent: unknown[];
};
type StorageState = Awaited<ReturnType<BrowserContext['storageState']>>;

export const readState = () =>
  JSON.parse(readFileSync(process.env.LIVE_STATE_FILE!, 'utf8')) as CombatState;
export const origin = `http://localhost:${process.env.LIVE_WEB_PORT ?? 5176}`;
// The sync budget from the party acceptance criteria: a move must reach every other browser within 1 s.
export const SYNC_BUDGET_MS = 1000;

// A seat's resume token lives in the browser's localStorage. A fresh context that carries only the sid
// cookie is a new device, so the server asks the host to approve the claim and the room never loads.
// Keep each account's storageState between opens, as party-round.spec.ts does, so each reconnect resumes
// its seat. Module-level so every combat spec in the same server boot shares the saved seats.
const storageByAccount = new Map<string, StorageState>();

export async function openMember(
  browser: Browser,
  member: Member,
  table: string,
  viewport?: { width: number; height: number },
): Promise<View> {
  const saved = storageByAccount.get(member.accountId);
  const context = await browser.newContext({
    ...(viewport ? { viewport } : {}),
    ...(saved ? { storageState: saved } : {}),
  });
  if (!saved)
    await context.addCookies([
      { name: 'sid', value: member.token, url: origin },
    ]);
  const page = await context.newPage();
  const frames: unknown[] = [];
  const sent: unknown[] = [];
  const parseInto =
    (list: unknown[]) => (event: { payload: string | Buffer }) => {
      if (typeof event.payload !== 'string') return;
      try {
        list.push(JSON.parse(event.payload));
      } catch {
        // Non-JSON frames are not protocol messages; skip them.
      }
    };
  page.on('websocket', (socket) => {
    socket.on('framereceived', parseInto(frames));
    socket.on('framesent', parseInto(sent));
  });
  await page.goto(`${origin}/rooms/${table}/game`);
  return { member, context, page, frames, sent };
}

/** Saves the seat's storage (resume token, sid cookie) before closing, so the next open resumes the seat. */
export async function closeMember(view: View) {
  storageByAccount.set(
    view.member.accountId,
    await view.context.storageState(),
  );
  await view.context.close();
  // Let the server-side close handler release the seat claim before the next reconnect.
  await new Promise((resolve) => setTimeout(resolve, 100));
}

/** The tracker's first entry is the active combatant; the server names it in the "Active combatant:" line. */
export async function activeCombatantId(page: Page): Promise<string> {
  // The line shows the display name; the entity id rides along in data-entity-id.
  const line = page.locator('.game-active');
  await expect(line).toBeVisible();
  return ((await line.getAttribute('data-entity-id')) ?? '').trim();
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

/**
 * Restores the area table's pristine board (a caster PC acting first, a goblin two cells away), then opens its
 * three seats. Every opened seat is pushed to `views` as it opens, so the caller's finally closes them all.
 */
export async function openAreaTable(
  browser: Browser,
  request: APIRequestContext,
  views: View[],
) {
  const res = await request.post('/api/test/reset-area');
  expect(res.ok(), `reset-area: ${res.status()}`).toBe(true);
  const { area } = readState();
  for (const member of [area.caster, area.guest, area.scout])
    views.push(await openMember(browser, member, area.table));
  for (const { page } of views)
    await expect(
      page.getByRole('list', { name: 'Initiative tracker' }),
    ).toBeVisible({ timeout: 30_000 });
  return views;
}

/**
 * The display name the UI shows for an entity, read from the initiative tracker entry that carries its
 * data-entity-id. Failing here means the name is missing or the tracker shows the raw id.
 */
export async function displayNameOf(
  page: Page,
  entityId: string,
): Promise<string> {
  const label = page.locator(
    `ol[aria-label="Initiative tracker"] [data-entity-id="${entityId}"]`,
  );
  await expect(label).toBeVisible();
  const name = ((await label.textContent()) ?? '').trim();
  expect(name, `${entityId} shows a display name`).not.toBe('');
  expect(name, `${entityId} shows a name, not its raw id`).not.toBe(entityId);
  return name;
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
    const id = (
      (await row.locator('th').getAttribute('data-entity-id')) ?? ''
    ).trim();
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
