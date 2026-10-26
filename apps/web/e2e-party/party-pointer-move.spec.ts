import { expect, test, type Page } from '@playwright/test';
import {
  closeMember,
  openAreaTable,
  SYNC_BUDGET_MS,
  tokenTable,
  type View,
} from './combat-helpers.js';

// Pointer equivalents of the keyboard move on the real server (see serve.party.live.ts, the area table).
// Every destination is a single click on the map canvas: no drag, no keyboard. Confirm and Cancel are the
// move-confirmation buttons. Assertions use the server's frames (the move reaches every seat) and the frames
// this page sent.

type Cell = { x: number; y: number };

function movesSent(sent: unknown[]) {
  return sent.filter((f) => {
    const { type, payload } = f as {
      type?: string;
      payload?: { command?: string };
    };
    return type === 'CombatCommand' && payload?.command === 'move';
  }) as { payload: { destination: Cell } }[];
}

async function mapSize(page: Page) {
  const label =
    (await page.locator('div.game-map__canvas').getAttribute('aria-label')) ??
    '';
  const match = /(\d+) columns by (\d+) rows/.exec(label);
  expect(match, 'the map announces its size').not.toBeNull();
  return { w: Number(match![1]), h: Number(match![2]) };
}

// One pointer click at a cell's centre. The canvas maps client pixels to cells at 32 px per cell (Game.tsx),
// so the position is scaled from canvas pixels to CSS pixels. Locator.click scrolls the canvas into view and
// measures from the element itself, so a canvas partly off screen still gets the right cell.
async function clickCell(page: Page, cell: Cell) {
  const canvas = page.locator('canvas#game-map-canvas');
  const box = await canvas.boundingBox();
  expect(box, 'the map canvas is on screen').not.toBeNull();
  const width = await canvas.evaluate((el) => (el as HTMLCanvasElement).width);
  const scale = box!.width / width;
  await canvas.click({
    position: {
      x: (cell.x + 0.5) * 32 * scale,
      y: (cell.y + 0.5) * 32 * scale,
    },
  });
}

// Candidate neighbours of the caster that are on the map and not occupied by a token.
async function freeNeighbours(page: Page, from: Cell) {
  const { w, h } = await mapSize(page);
  const tokens = await tokenTable(page);
  const taken = (c: Cell) => tokens.some((t) => t.x === c.x && t.y === c.y);
  return [
    { x: from.x + 1, y: from.y },
    { x: from.x - 1, y: from.y },
    { x: from.x, y: from.y + 1 },
    { x: from.x, y: from.y - 1 },
  ].filter((c) => c.x >= 0 && c.y >= 0 && c.x < w && c.y < h && !taken(c));
}

// Clicks a neighbour cell and keeps it only if the map's own preview reports a reachable path.
async function pointAtReachableCell(page: Page, from: Cell) {
  const map = page.getByRole('application', { name: 'Battle map' });
  for (const cell of await freeNeighbours(page, from)) {
    await clickCell(page, cell);
    await expect(map).toHaveAttribute('data-moving', 'true');
    const text =
      (await page
        .locator('p')
        .filter({ hasText: /^Move preview: / })
        .textContent()) ?? '';
    if (/feet$/.test(text)) return cell;
    // Not reachable from here: leave move mode with the pointer and try the next neighbour.
    await page.getByRole('button', { name: 'Cancel move' }).click();
  }
  throw new Error('no reachable neighbour cell found for a pointer move');
}

test.describe('party pointer equivalents for move', () => {
  test.setTimeout(180_000);

  test('a pointer click on a reachable cell, then Confirm move, moves the caster on every seat', async ({
    browser,
    request,
  }) => {
    const views: View[] = [];
    try {
      await openAreaTable(browser, request, views);
      const [caster, ...others] = views;
      const { page } = caster!;
      const map = page.getByRole('application', { name: 'Battle map' });
      const activeToken = page.locator(
        'ul[aria-label="Combat tokens"] li[data-active="true"]',
      );
      const start = {
        x: Number(await activeToken.getAttribute('data-x')),
        y: Number(await activeToken.getAttribute('data-y')),
      };

      let destination: Cell | null = null;
      await test.step('a pointer click on a reachable cell sets the move destination', async () => {
        destination = await pointAtReachableCell(page, start);
        await expect(map).toHaveAttribute('data-moving', 'true');
        await expect(
          page.getByRole('button', { name: 'Confirm move' }),
        ).toBeEnabled();
      });

      await test.step('a pointer click on Confirm move sends the move; every seat syncs within the budget', async () => {
        const target = destination!;
        const t0 = Date.now();
        await page.getByRole('button', { name: 'Confirm move' }).click();
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
          `party pointer move sync: ${elapsed} ms to all ${views.length} browsers`,
        );
        expect(elapsed).toBeLessThanOrEqual(SYNC_BUDGET_MS);
        await expect
          .poll(() => movesSent(caster!.sent).length)
          .toBeGreaterThan(0);
        expect(movesSent(caster!.sent).at(-1)!.payload.destination).toEqual(
          target,
        );
        await expect(map).toHaveAttribute('data-moving', 'false');
        for (const { page: p } of others)
          await expect(
            p.getByText(`Active combatant: ${caster!.member.entityId}`),
          ).toBeVisible();
      });
    } finally {
      for (const view of views) await closeMember(view);
    }
  });

  test('a pointer click on Cancel move leaves the caster where it was and sends nothing', async ({
    browser,
    request,
  }) => {
    const views: View[] = [];
    try {
      await openAreaTable(browser, request, views);
      const [caster] = views;
      const { page } = caster!;
      const map = page.getByRole('application', { name: 'Battle map' });
      const activeToken = page.locator(
        'ul[aria-label="Combat tokens"] li[data-active="true"]',
      );
      const start = {
        x: await activeToken.getAttribute('data-x'),
        y: await activeToken.getAttribute('data-y'),
      };

      await test.step('a pointer click on a reachable cell opens the move preview', async () => {
        await pointAtReachableCell(page, {
          x: Number(start.x),
          y: Number(start.y),
        });
        await expect(map).toHaveAttribute('data-moving', 'true');
      });

      await test.step('a pointer click on Cancel move ends move mode; the token stays and no move is sent', async () => {
        await page.getByRole('button', { name: 'Cancel move' }).click();
        await expect(map).toHaveAttribute('data-moving', 'false');
        await expect(activeToken).toHaveAttribute('data-x', start.x!);
        await expect(activeToken).toHaveAttribute('data-y', start.y!);
        await expect(
          page
            .locator('[aria-live="polite"]')
            .filter({ hasText: 'Movement cancelled.' }),
        ).toBeVisible();
        expect(movesSent(caster!.sent)).toHaveLength(0);
      });
    } finally {
      for (const view of views) await closeMember(view);
    }
  });
});
