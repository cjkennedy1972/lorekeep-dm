# M2-07: cross-browser and axe coverage (2026-10-08)

Playwright 1.63.0 on macOS arm64: Chromium, Firefox, WebKit 26.6 (Playwright build, not Safari.app).

## Results (`pnpm --filter @game/web exec playwright test`)

| Spec | chromium | firefox | webkit |
| --- | --- | --- | --- |
| sandbox-combat.spec.ts (keyboard-only to CombatEnded) | pass | pass | pass |
| cross-browser.spec.ts (canvas painted, no page/console errors) | pass | pass | pass |
| axe.spec.ts x3 screens | pass | pass | pass |
| auth, settings, shell, lobby (existing, Chromium-only) | pass* | not run | not run |

\* lobby "create a table" failed locally only because a foreign mock server from another
worktree (m1-41) already held port 8787 and `reuseExistingServer` reused it; CI starts its own.

## axe-core (@axe-core/playwright 4.13, tags wcag2a/2aa/21a/21aa)
Screens: `/sandbox/combat`, `/signup` (account), `/characters/new` (character creation).
Fails on any critical or serious violation. Result: 0 on all three screens in all three
browsers. No waivers.

## Why Firefox/WebKit run only three specs
Running the other existing specs unchanged on the other engines fails for harness reasons, not
product bugs (existing specs are not edited):
- webkit: `shell` skip-link, `settings` Export button and `auth` checkbox `Tab` never focus.
  Safari/WebKit on macOS skips links, buttons and checkboxes in the Tab order unless
  "Press Tab to highlight each item" is enabled (default off). The sandbox flow uses
  `.focus()` first and key shortcuts, so it is unaffected.
- webkit/firefox: `lobby` uses `permissions: ['clipboard-read','clipboard-write']`, which
  these engines reject ("Unknown permission").
No product defect was found in any browser.

## CI
Single job installs chromium, firefox and webkit (`--with-deps`) and runs `playwright test`:
chromium runs all specs; firefox/webkit run sandbox-combat, cross-browser and axe.

## Unverified
Edge (Chromium-based, not run), physical Safari, and screen readers (NVDA, JAWS, VoiceOver).
axe covers automatable rules only.
