import { readFileSync } from 'node:fs';
import {
  expect,
  test,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';
import {
  attachSeatDiagnostics,
  SOCKET_HOOK,
  startSeatTrace,
  type SeatView,
  type TraceEvent,
} from './diagnostics';
import { mintSeatResume } from './seat-resume';

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
  /** The role the seat plays in its table, e.g. `combat.host`. Used in failure attachments only. */
  label: string;
  mintStatus: number;
  trace: TraceEvent[];
};

export const readState = () =>
  JSON.parse(readFileSync(process.env.LIVE_STATE_FILE!, 'utf8')) as CombatState;

// Every token in the state file. Used to scrub failure attachments.
export function stateTokens(): string[] {
  const tokens: string[] = [];
  const walk = (node: unknown) => {
    if (typeof node !== 'object' || node === null) return;
    for (const [key, value] of Object.entries(node))
      if (key === 'token' && typeof value === 'string') tokens.push(value);
      else walk(value);
  };
  walk(readState());
  return tokens;
}

/** `combat.host` for a seat in the state file; `unknown-seat` if the member is not listed there. */
export function labelFor(member: { accountId: string }): string {
  for (const [table, group] of Object.entries(readState()))
    if (typeof group === 'object' && group !== null)
      for (const [role, seat] of Object.entries(group))
        if (
          typeof seat === 'object' &&
          seat !== null &&
          (seat as Member).accountId === member.accountId
        )
          return `${table}.${role}`;
  return 'unknown-seat';
}
export const origin = `http://localhost:${process.env.LIVE_WEB_PORT ?? 5176}`;
// The sync budget from the party acceptance criteria: a move must reach every other browser within 1 s.
export const SYNC_BUDGET_MS = 1000;

// A seat's resume token lives in the browser's localStorage. A fresh context that carries only the sid
// cookie is a new device, so the server asks the host to approve the claim and the room never loads.
// Each open mints a fresh one-time token for its seat. Replaying a saved storageState instead reuses a
// token the server has already rotated, which lands on the same host-approval wait.
export async function openMember(
  browser: Browser,
  member: Member,
  table: string,
  viewport?: { width: number; height: number },
): Promise<View> {
  const context = await browser.newContext(viewport ? { viewport } : undefined);
  await context.addCookies([{ name: 'sid', value: member.token, url: origin }]);
  await context.addInitScript(SOCKET_HOOK);
  const mintStatus = await mintSeatResume(context, origin, table, member);
  const page = await context.newPage();
  const trace = startSeatTrace(page);
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
  return {
    member,
    context,
    page,
    frames,
    sent,
    label: labelFor(member),
    mintStatus,
    trace,
  };
}

/** Closes the member's context and lets the server release the seat claim before the next open. */
export async function closeMember(view: View) {
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
 * Waits for every seat's Initiative tracker. On a timeout it attaches the evidence for all the views, then
 * rethrows the original error. The wait and its 30 s timeout are unchanged.
 */
export async function awaitTrackers(views: View[]) {
  for (const view of views) {
    try {
      await expect(
        view.page.getByRole('list', { name: 'Initiative tracker' }),
      ).toBeVisible({ timeout: 30_000 });
    } catch (error) {
      await attachFailure(views, error);
      throw error;
    }
  }
}

/** Attaches the failure evidence for the given seats to the running test. */
export async function attachFailure(views: View[], error: unknown) {
  try {
    await attachSeatDiagnostics(
      test.info(),
      views.map(seatOf),
      error,
      stateTokens(),
    );
  } catch (attachError) {
    // Evidence is best effort, and the caller still rethrows the original error. Say so in the run log.
    console.error('party diagnostics could not be attached:', attachError);
  }
}

function seatOf(view: View): SeatView {
  return {
    label: view.label,
    entityId: view.member.entityId,
    mintStatus: view.mintStatus,
    page: view.page,
    trace: view.trace,
  };
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
  await awaitTrackers(views);
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
