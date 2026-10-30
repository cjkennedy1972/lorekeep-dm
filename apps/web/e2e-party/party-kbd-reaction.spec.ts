import {
  expect,
  test,
  type APIRequestContext,
  type Browser,
} from '@playwright/test';
import {
  closeMember,
  displayNameOf,
  openMember,
  readState,
  type Member,
  type View,
} from './combat-helpers.js';

// Keyboard-only PC opportunity-attack reaction on the real server (see serve.party.live.ts).
// The reactor's window is staged by the test-only hook /api/test/stage-reaction AFTER all three seats
// have connected: the goblin's real engine move out of the reactor's reach, applied with the same
// moveAlong/applyMovement a monster turn uses. Room.join would decline a window whose reactor is not
// connected, so staging before the seats join cannot reach a browser.
// Each test stages a fresh window on the pristine board. Assertions read the server's own frames:
// ReactionPrompt (reactor only), ReactionPromptOpen (every seat), and the CombatEvents outcome.

const DIALOG = { name: 'Opportunity attack' } as const;

function framesOfType(frames: unknown[], type: string) {
  return frames.filter((f) => (f as { type?: string }).type === type);
}

function combatEventsOfType(frames: unknown[], type: string) {
  return frames.flatMap((frame) => {
    const { type: frameType, payload } = frame as {
      type?: string;
      payload?: { events?: { type?: string; choice?: string }[] };
    };
    return frameType === 'CombatEvents'
      ? (payload?.events ?? []).filter((event) => event.type === type)
      : [];
  });
}

// A reactor's own answer (Accept, Decline, or Escape) is ReactionAnswered with its choice. ReactionDeclined is
// reserved for the table closing the window (timeout or combat end), so it is not the reactor's answer.
function answeredWith(frames: unknown[], choice: 'take' | 'decline') {
  return combatEventsOfType(frames, 'ReactionAnswered').filter(
    (event) => (event as { choice?: string }).choice === choice,
  );
}

// The dialog's countdown re-renders every 100 ms. The Enter below is only meaningful if focus survives those
// ticks, so each test waits this long between focusing its target and pressing Enter. No condition marks the
// end of that window, so this is a fixed wait used only at those two points.
const FOCUS_SETTLE_MS = 300;

// Every opened seat is pushed to `views` as it opens, so the caller's finally closes them even when a
// later step fails. A seat that is never closed loses its resume token and cannot reconnect in later specs.
async function openReactionTable(browser: Browser, views: View[]) {
  const { reaction } = readState();
  for (const member of [reaction.host, reaction.guest, reaction.scout])
    views.push(await openMember(browser, member, reaction.table));
  for (const { page } of views)
    await expect(
      page.getByRole('list', { name: 'Initiative tracker' }),
    ).toBeVisible({ timeout: 30_000 });
}

async function stageWindow(request: APIRequestContext, member: Member) {
  const res = await request.post('/api/test/stage-reaction', {
    data: { accountId: member.accountId },
  });
  expect(res.ok(), `stage-reaction: ${res.status()} ${await res.text()}`).toBe(
    true,
  );
  return (await res.json()) as { ok: true; reactorEntityId: string };
}

// Opens the table with every seat connected, then stages the reactor's window.
async function openWindow(
  browser: Browser,
  request: APIRequestContext,
  views: View[],
) {
  const { reaction } = readState();
  await openReactionTable(browser, views);
  const reactorView = views.find(
    (v) => v.member.accountId === reaction.guest.accountId,
  )!;
  const others = views.filter((v) => v !== reactorView);
  const staged = await stageWindow(request, reaction.guest);
  expect(staged.reactorEntityId).toBe(reaction.guest.entityId);
  return { reactorView, others, reactorEntity: staged.reactorEntityId };
}

test.describe('party keyboard-only opportunity attack', () => {
  test.setTimeout(180_000);

  test('the reactor answers Accept from the keyboard; other seats see only the window status', async ({
    browser,
    request,
  }) => {
    const views: View[] = [];
    try {
      const { reactorView, others, reactorEntity } = await openWindow(
        browser,
        request,
        views,
      );

      await test.step('the server prompts only the reactor; every other seat gets the open notice', async () => {
        await expect
          .poll(() => framesOfType(reactorView.frames, 'ReactionPrompt').length)
          .toBeGreaterThan(0);
        const prompt = framesOfType(
          reactorView.frames,
          'ReactionPrompt',
        )[0] as { payload: { options: string[] } };
        expect(prompt.payload.options).toEqual(['take', 'decline']);
        for (const v of others) {
          await expect
            .poll(() => framesOfType(v.frames, 'ReactionPromptOpen').length)
            .toBeGreaterThan(0);
          expect(framesOfType(v.frames, 'ReactionPrompt')).toHaveLength(0);
        }
      });

      await test.step('the reactor sees the dialog, focused on Accept; others see only the status', async () => {
        const dialog = reactorView.page.getByRole('dialog', DIALOG);
        await expect(dialog).toBeVisible();
        await expect(
          dialog.getByRole('button', { name: 'Accept' }),
        ).toBeFocused();
        for (const v of others) {
          // The window names the reactor by the display name this seat's tracker shows, never by raw entity id.
          const reactorName = await displayNameOf(v.page, reactorEntity);
          const notice = v.page.getByRole('status').filter({
            hasText: `Reaction window open for ${reactorName}.`,
          });
          await expect(notice).toBeVisible();
          await expect(notice).not.toContainText(reactorEntity);
          await expect(v.page.getByRole('dialog', DIALOG)).toHaveCount(0);
        }
      });

      await test.step('Enter on Accept answers take; the window closes for every seat', async () => {
        // Let several countdown ticks pass; Enter must hit the focused Accept, not a refocused button.
        await reactorView.page.waitForTimeout(FOCUS_SETTLE_MS);
        await expect(
          reactorView.page
            .getByRole('dialog', DIALOG)
            .getByRole('button', { name: 'Accept' }),
        ).toBeFocused();
        await reactorView.page.keyboard.press('Enter');
        await expect
          .poll(() => answeredWith(reactorView.frames, 'take').length)
          .toBeGreaterThan(0);
        for (const v of views)
          await expect(v.page.getByRole('dialog', DIALOG)).toHaveCount(0);
      });
    } finally {
      for (const view of views) await closeMember(view);
    }
  });

  test('the reactor declines from the keyboard (Tab to Decline, Enter)', async ({
    browser,
    request,
  }) => {
    const views: View[] = [];
    try {
      const { reactorView, others } = await openWindow(browser, request, views);

      await test.step('the reactor tabs from Accept to Decline and presses Enter', async () => {
        const dialog = reactorView.page.getByRole('dialog', DIALOG);
        await expect(dialog).toBeVisible();
        await reactorView.page.keyboard.press('Tab');
        await expect(
          dialog.getByRole('button', { name: 'Decline' }),
        ).toBeFocused();
        // Let several countdown ticks pass; Enter must hit the focused button, not a refocused Accept.
        await reactorView.page.waitForTimeout(FOCUS_SETTLE_MS);
        await expect(
          dialog.getByRole('button', { name: 'Decline' }),
        ).toBeFocused();
        await reactorView.page.keyboard.press('Enter');
      });

      await test.step('the server records the decline; no seat keeps a dialog open', async () => {
        await expect
          .poll(() => answeredWith(reactorView.frames, 'decline').length)
          .toBeGreaterThan(0);
        for (const v of [reactorView, ...others])
          await expect(v.page.getByRole('dialog', DIALOG)).toHaveCount(0);
        expect(answeredWith(reactorView.frames, 'take')).toHaveLength(0);
      });
    } finally {
      for (const view of views) await closeMember(view);
    }
  });

  test('Escape on the reaction dialog declines', async ({
    browser,
    request,
  }) => {
    const views: View[] = [];
    try {
      const { reactorView, others } = await openWindow(browser, request, views);

      await test.step('Escape declines without any pointer input', async () => {
        await expect(
          reactorView.page.getByRole('dialog', DIALOG),
        ).toBeVisible();
        await reactorView.page.keyboard.press('Escape');
      });

      await test.step('the server records the decline and every seat closes the window', async () => {
        await expect
          .poll(() => answeredWith(reactorView.frames, 'decline').length)
          .toBeGreaterThan(0);
        for (const v of [reactorView, ...others])
          await expect(v.page.getByRole('dialog', DIALOG)).toHaveCount(0);
      });
    } finally {
      for (const view of views) await closeMember(view);
    }
  });
});
