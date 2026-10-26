import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import {
  closeMember,
  openAreaTable,
  readState,
  tabTo,
  type View,
} from './combat-helpers.js';

// Keyboard-only area aim on the real server (see serve.party.live.ts, the area table). The caster PC is a
// wizard with Burning Hands prepared and acts first. Each test restores the pristine board through
// /api/test/reset-area. Assertions use the server's own frames (CombatOptions for the engine-issued option ids,
// CombatEvents for the resolution) and the frames this page sent.

const GOBLIN = 'ent_goblin-minion_1';

type AreaOptionFrame = {
  optionId: string;
  affected: { id: string; relation: string }[];
};

function framesOfType(frames: unknown[], type: string) {
  return frames.filter((f) => (f as { type?: string }).type === type);
}

// The area options the server issued in its latest CombatOptions frame for this seat.
function areaOptionsFrom(frames: unknown[]): AreaOptionFrame[] {
  const last = framesOfType(frames, 'CombatOptions').at(-1) as
    | { payload?: { areas?: AreaOptionFrame[] } }
    | undefined;
  return last?.payload?.areas ?? [];
}

// Cast commands this page sent (the wire shape is CombatCommand with payload.command).
function castsSent(sent: unknown[]) {
  return sent.filter((f) => {
    const { type, payload } = f as {
      type?: string;
      payload?: { command?: string };
    };
    return type === 'CombatCommand' && payload?.command === 'cast';
  }) as { payload: { target: { kind: string; ref: string } } }[];
}

function combatEventsOfType(frames: unknown[], type: string) {
  return frames.flatMap((frame) => {
    const { type: frameType, payload } = frame as {
      type?: string;
      payload?: { events?: { type?: string }[] };
    };
    return frameType === 'CombatEvents'
      ? (payload?.events ?? []).filter((event) => event.type === type)
      : [];
  });
}

// Tab until focus is on a radio of the area-aim list (native radio group, one tab stop).
async function tabToAreaList(page: Page) {
  for (let presses = 0; presses < 120; presses += 1) {
    const onAim = await page.evaluate(
      () => (document.activeElement as HTMLInputElement | null)?.name,
    );
    if (onAim === 'area-aim') return;
    await page.keyboard.press('Tab');
  }
  throw new Error('keyboard focus never reached the area-aim list');
}

// Keyboard-only: Tab to "Refresh combat options", press Enter, and wait for the engine's area list.
async function openAreaList(page: Page) {
  await tabTo(page, 'Refresh combat options');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('group', { name: 'Area aims' })).toBeVisible();
}

const aimRadio = (page: Page, index: number) =>
  page.locator('input[name="area-aim"]').nth(index);
const preview = (page: Page) =>
  page.locator('fieldset.area-aim p[aria-live="polite"]');

test.describe('party keyboard-only area aim', () => {
  test.setTimeout(180_000);

  test('the caster opens the area list, arrows to an aim, reads the preview, and Enter casts it; the server resolves it', async ({
    browser,
    request,
  }) => {
    const views: View[] = [];
    try {
      await openAreaTable(browser, request, views);
      const [caster, ...others] = views;
      const { page } = caster!;
      const { area } = readState();

      await test.step('the caster opens the area-aim list from the keyboard', async () => {
        await openAreaList(page);
      });

      // The server's own option list decides the arrow count: the first aim that catches the goblin.
      const aims = areaOptionsFrom(caster!.frames);
      const target = aims.findIndex((aim) =>
        aim.affected.some((unit) => unit.id === GOBLIN),
      );

      await test.step('arrow keys walk the aims and the preview names the affected units', async () => {
        expect(target, 'an engine aim catches the goblin').toBeGreaterThan(0);
        await tabToAreaList(page);
        for (let step = 0; step < target; step += 1)
          await page.keyboard.press('ArrowDown');
        await expect(aimRadio(page, target)).toBeChecked();
        await expect(preview(page)).toHaveText(
          /^\d+ affected: .+ \((enemy|ally)\)\.$/,
        );
        await expect(preview(page)).toContainText('(enemy)');
      });

      await test.step('axe: no serious or critical violations on the area-aim state', async () => {
        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze();
        const blocking = results.violations.filter(
          (v) => v.impact === 'critical' || v.impact === 'serious',
        );
        expect(
          blocking.map(
            (v) => `${v.id} (${v.impact}): ${v.nodes.length} node(s)`,
          ),
          'no serious/critical axe violations on the area-aim state',
        ).toEqual([]);
      });

      await test.step('Tab to Cast area and press Enter: the sent option ref is the one the server issued', async () => {
        await tabTo(page, 'Cast area');
        await page.keyboard.press('Enter');
        await expect
          .poll(() => castsSent(caster!.sent).length)
          .toBeGreaterThan(0);
        const sent = castsSent(caster!.sent).at(-1)!;
        expect(sent.payload.target.kind).toBe('option');
        expect(sent.payload.target.ref).toBe(aims[target]!.optionId);
      });

      await test.step('the server resolves the cast: SpellCast by the caster and AreaResolved hitting the goblin, on every seat', async () => {
        for (const view of views) {
          await expect
            .poll(
              () =>
                combatEventsOfType(view.frames, 'SpellCast').filter(
                  (e) =>
                    (e as { entityId?: string }).entityId ===
                    area.caster.entityId,
                ).length,
            )
            .toBeGreaterThan(0);
        }
        const resolved = combatEventsOfType(caster!.frames, 'AreaResolved') as {
          affected: string[];
        }[];
        expect(resolved.length).toBeGreaterThan(0);
        expect(resolved.at(-1)!.affected).toContain(GOBLIN);
        const cast = combatEventsOfType(caster!.frames, 'SpellCast').at(-1) as {
          spellId?: string;
        };
        expect(cast.spellId).toBe('spell:burning-hands');
        for (const other of others)
          expect(
            combatEventsOfType(other.frames, 'AreaResolved').length,
          ).toBeGreaterThan(0);
      });
    } finally {
      for (const view of views) await closeMember(view);
    }
  });

  test('Escape clears the aim without casting', async ({
    browser,
    request,
  }) => {
    const views: View[] = [];
    try {
      await openAreaTable(browser, request, views);
      const [caster] = views;
      const { page } = caster!;
      await openAreaList(page);
      const target = areaOptionsFrom(caster!.frames).findIndex((aim) =>
        aim.affected.some((unit) => unit.id === GOBLIN),
      );

      await test.step('an aim is selected with the arrow keys', async () => {
        await tabToAreaList(page);
        for (let step = 0; step < target; step += 1)
          await page.keyboard.press('ArrowDown');
        await expect(aimRadio(page, target)).toBeChecked();
        await expect(preview(page)).toContainText('(enemy)');
      });

      await test.step('Escape on the aim list clears the selection; Cast area is disabled; nothing is sent', async () => {
        await page.keyboard.press('Escape');
        await expect(aimRadio(page, target)).not.toBeChecked();
        await expect(preview(page)).toHaveText(
          'Choose an aim to preview who it affects.',
        );
        await expect(
          page.getByRole('button', { name: 'Cast area' }),
        ).toBeDisabled();
        expect(castsSent(caster!.sent)).toHaveLength(0);
      });
    } finally {
      for (const view of views) await closeMember(view);
    }
  });

  test('Cancel area aim clears the aim without casting', async ({
    browser,
    request,
  }) => {
    const views: View[] = [];
    try {
      await openAreaTable(browser, request, views);
      const [caster] = views;
      const { page } = caster!;
      await openAreaList(page);
      const target = areaOptionsFrom(caster!.frames).findIndex((aim) =>
        aim.affected.some((unit) => unit.id === GOBLIN),
      );

      await test.step('an aim is selected with the arrow keys', async () => {
        await tabToAreaList(page);
        for (let step = 0; step < target; step += 1)
          await page.keyboard.press('ArrowDown');
        await expect(aimRadio(page, target)).toBeChecked();
      });

      await test.step('Tab to Cancel area aim and press Enter: the selection clears and nothing is cast', async () => {
        await tabTo(page, 'Cancel area aim');
        await page.keyboard.press('Enter');
        await expect(aimRadio(page, target)).not.toBeChecked();
        await expect(preview(page)).toHaveText(
          'Choose an aim to preview who it affects.',
        );
        await expect(
          page.getByRole('button', { name: 'Cast area' }),
        ).toBeDisabled();
        expect(castsSent(caster!.sent)).toHaveLength(0);
      });
    } finally {
      for (const view of views) await closeMember(view);
    }
  });
});
