import { expect, test, type Page } from '@playwright/test';

const stamp = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const BIRTH = '01011990'; // typed into the mm/dd/yyyy segments of the date input
const BIRTH_ISO = '1990-01-01';

// Chromium's date input has an extra tab stop (the picker button); Tab until the target has focus.
async function tabTo(page: Page, id: string) {
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press('Tab');
    if (await page.evaluate((t) => document.activeElement?.id === t, id))
      return;
  }
  throw new Error(`Tab never reached #${id}`);
}

test('keyboard-only signup; birthdate never reaches storage or the console', async ({
  page,
}) => {
  const logs: string[] = [];
  page.on('console', (m) => logs.push(m.text()));
  await page.goto('/signup');
  await page.getByRole('heading', { name: 'Create your account' }).waitFor();

  await page.getByLabel('Email').focus();
  await page.keyboard.type(`kb${stamp()}@example.com`);
  await page.keyboard.press('Tab');
  await page.keyboard.type('Keyboard Kay');
  await page.keyboard.press('Tab');
  await page.keyboard.type('correct-horse-battery');
  await page.keyboard.press('Tab');
  await page.keyboard.type(BIRTH);
  await tabTo(page, 'terms');
  await page.keyboard.press('Space');
  await tabTo(page, 'adult');
  await page.keyboard.press('Space');
  await page.keyboard.press('Tab'); // the submit button
  await page.keyboard.press('Enter');
  await page.getByRole('heading', { name: 'Check your email' }).waitFor();

  const stored = await page.evaluate(() =>
    JSON.stringify([{ ...localStorage }, { ...sessionStorage }]),
  );
  expect(stored).not.toContain(BIRTH_ISO);
  expect(logs.join('\n')).not.toContain(BIRTH_ISO);
});

test('field errors are announced and tied to their inputs', async ({
  page,
}) => {
  await page.goto('/signup');
  await page.getByRole('button', { name: 'Create account' }).click();
  const email = page.getByLabel('Email');
  await expect(email).toBeFocused();
  await expect(email).toHaveAccessibleDescription(
    'Enter a valid email address.',
  );
  await expect(page.getByRole('alert').first()).toBeVisible();
});

test('under-18 gets a neutral refusal and no form to retry', async ({
  page,
}) => {
  await page.goto('/signup');
  await page.getByLabel('Email').fill(`kid${stamp()}@example.com`);
  await page.getByLabel('Display name').fill('Kid');
  await page.getByLabel('Password').fill('correct-horse-battery');
  const year = new Date().getFullYear() - 10;
  await page.getByLabel('Date of birth').fill(`${year}-01-01`);
  await page.getByLabel(/accept the Terms/).check();
  await page.getByLabel(/18 years or older/).check();
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('alert')).toHaveText(
    'You must be 18 or older to create an account.',
  );
  await expect(
    page.getByRole('button', { name: 'Create account' }),
  ).toHaveCount(0);
});

test('login: same error for unknown email and wrong password; keyboard login returns to the join', async ({
  browser,
}) => {
  const email = `login${stamp()}@example.com`;
  const hostCtx = await browser.newContext();
  await hostCtx.request.post('http://localhost:8787/api/signup', {
    data: {
      email,
      password: 'correct-horse-battery',
      displayName: 'Lou',
      birthdate: BIRTH_ISO,
    },
  });
  const created = await (
    await hostCtx.request.post('http://localhost:8787/api/rooms', {
      data: { name: 'Return Trip' },
    })
  ).json();
  const url = `/join/${created.room.code}`;

  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(url);
  await expect(page).toHaveURL(/\/login$/);

  const attempt = async (e: string, pw: string) => {
    await page.getByLabel('Email').fill(e);
    await page.getByLabel('Password').fill(pw);
    await page.getByRole('button', { name: 'Log in' }).click();
    return page.getByRole('alert').first().innerText();
  };
  const unknown = await attempt(
    `nobody${stamp()}@example.com`,
    'whatever-password',
  );
  const wrong = await attempt(email, 'definitely-wrong-pw');
  expect(unknown).toBe(wrong);

  // The host's own account exists only in hostCtx; log in through the keyboard with the right password.
  await page.getByLabel('Email').focus();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type(email);
  await page.keyboard.press('Tab');
  await page.keyboard.type('correct-horse-battery');
  await page.keyboard.press('Enter');
  await page.getByRole('heading', { name: 'Return Trip' }).waitFor();
  expect(new URL(page.url()).pathname).toMatch(/^\/rooms\//);
});

test('verify and reset pages work end to end', async ({ page }) => {
  await page.goto('/verify?token=valid-token');
  await page.getByLabel('Password').fill('a-brand-new-password');
  await page.getByRole('button', { name: 'Verify email' }).click();
  await expect(page.getByText(/email is verified/i)).toBeVisible();
  await page.goto('/reset?token=valid-token');
  await page.getByLabel('New password').fill('a-brand-new-password');
  await page.getByRole('button', { name: 'Set new password' }).click();
  await expect(page.getByRole('heading', { name: 'Log in' })).toBeVisible();
});
