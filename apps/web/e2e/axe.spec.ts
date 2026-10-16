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

test('axe: no critical or serious violations on safety settings lobby', async ({
  browser,
}) => {
  const context = await browser.newContext();
  try {
    const response = await context.request.post(
      'http://localhost:8787/api/signup',
      {
        data: {
          email: `axe-lobby-${Date.now()}@example.com`,
          password: 'correct-horse-battery',
          displayName: 'Axe Lobby',
          birthdate: '1990-01-01',
        },
      },
    );
    expect(response.ok()).toBe(true);
    const table = await context.request.post(
      'http://localhost:8787/api/rooms',
      {
        data: { name: 'Safety audit table' },
      },
    );
    expect(table.ok()).toBe(true);
    const { room } = (await table.json()) as { room: { id: string } };
    const page = await context.newPage();
    await page.goto(`/rooms/${room.id}`);
    await page.getByRole('heading', { name: 'Safety audit table' }).waitFor();
    const { violations } = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(
      violations
        .filter((v) => v.impact === 'critical' || v.impact === 'serious')
        .map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(' | ')}`),
    ).toEqual([]);
  } finally {
    await context.close();
  }
});

test('axe: no critical or serious violations on join-time content opt-out', async ({
  browser,
}) => {
  const host = await browser.newContext();
  const guest = await browser.newContext();
  try {
    for (const [context, name] of [
      [host, 'Axe Join Host'],
      [guest, 'Axe Join Guest'],
    ] as const) {
      const response = await context.request.post(
        'http://localhost:8787/api/signup',
        {
          data: {
            email: `axe-join-${name.replaceAll(' ', '-').toLowerCase()}-${Date.now()}@example.com`,
            password: 'correct-horse-battery',
            displayName: name,
            birthdate: '1990-01-01',
          },
        },
      );
      expect(response.ok()).toBe(true);
    }
    const table = await host.request.post('http://localhost:8787/api/rooms', {
      data: { name: 'Join safety audit' },
    });
    expect(table.ok()).toBe(true);
    const { room } = (await table.json()) as {
      room: { code: string };
    };
    const page = await guest.newPage();
    await page.goto(`/join/${room.code}`);
    await page.getByRole('button', { name: 'Join table' }).waitFor();
    const { violations } = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(
      violations
        .filter((v) => v.impact === 'critical' || v.impact === 'serious')
        .map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(' | ')}`),
    ).toEqual([]);
  } finally {
    await Promise.all([host.close(), guest.close()]);
  }
});

test('axe: no critical or serious violations on in-game safety controls', async ({
  browser,
}) => {
  const context = await browser.newContext();
  try {
    const signup = await context.request.post(
      'http://localhost:8787/api/signup',
      {
        data: {
          email: `axe-game-${Date.now()}@example.com`,
          password: 'correct-horse-battery',
          displayName: 'Axe Game',
          birthdate: '1990-01-01',
        },
      },
    );
    expect(signup.ok()).toBe(true);
    const table = await context.request.post(
      'http://localhost:8787/api/tables',
      {
        data: {
          name: 'Game safety audit',
          adventureId: 'adventure:fixture-1',
          difficulty: 'moderate',
          startingLevel: 1,
        },
      },
    );
    expect(table.ok()).toBe(true);
    const { game } = (await table.json()) as { game: { id: string } };
    const page = await context.newPage();
    await page.goto(`/rooms/${game.id}/game`);
    await page.getByRole('region', { name: 'Safety controls' }).waitFor();
    await page.getByRole('button', { name: 'X-card (anonymous)' }).waitFor();
    const { violations } = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(
      violations
        .filter((v) => v.impact === 'critical' || v.impact === 'serious')
        .map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(' | ')}`),
    ).toEqual([]);
  } finally {
    await context.close();
  }
});
