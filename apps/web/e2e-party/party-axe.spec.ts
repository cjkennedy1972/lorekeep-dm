import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { closeMember, openMember, readState } from './combat-helpers';

// Real-browser axe (including color-contrast) on the mid-combat game screen, in both themes.
// The pre-combat screen with the drawers open is covered in party-round.spec.ts.
for (const scheme of ['dark', 'light'] as const) {
  test(`axe: no critical or serious violations on the combat game screen (${scheme})`, async ({
    browser,
  }) => {
    const state = readState();
    const view = await openMember(
      browser,
      state.combat.host,
      state.combat.table,
    );
    try {
      await view.page.emulateMedia({ colorScheme: scheme });
      await expect(view.page.getByText('Connected to the room.')).toBeVisible();
      await expect(
        view.page.getByRole('list', { name: 'Initiative tracker' }),
      ).toBeVisible();
      const { violations } = await new AxeBuilder({ page: view.page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      const bad = violations.filter(
        (v) => v.impact === 'critical' || v.impact === 'serious',
      );
      expect(
        bad.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(' | ')}`),
      ).toEqual([]);
    } finally {
      await closeMember(view);
    }
  });
}
