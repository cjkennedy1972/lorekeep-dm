import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

const screens = [
  {
    name: 'combat sandbox',
    path: '/sandbox/combat',
    ready: 'Solo combat sandbox',
  },
  { name: 'account (signup)', path: '/signup', ready: 'Create your account' },
  { name: 'character creation', path: '/characters/new', ready: 'Quick build' },
];

for (const s of screens) {
  test(`axe: no critical or serious violations on ${s.name}`, async ({
    page,
  }) => {
    await page.goto(s.path);
    await page.getByRole('heading', { name: s.ready }).waitFor();
    const { violations } = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    const bad = violations.filter(
      (v) => v.impact === 'critical' || v.impact === 'serious',
    );
    expect(
      bad.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(' | ')}`),
    ).toEqual([]);
  });
}
