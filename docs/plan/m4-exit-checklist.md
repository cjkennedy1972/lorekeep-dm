# M4 exit checklist

Source: [architecture §11](../architecture.md#11-phased-build-plan-v03) and [M4 breakdown](m4-breakdown.md). Status reconciled against `origin/main` and GitHub as of 2026-10-25.

M4 is not exit-ready until all four architecture gates below have evidence. A merged implementation PR is not a substitute for the milestone-level evidence (especially real playtest and keyboard-only completion).

| Architecture §11 M4 exit criterion | Evidence required to call it met | Current status |
|---|---|---|
| **Six-sim-player scripted sessions green** | Exact-head passing run of the scripted six-client Room/WS scenarios against the real persistence path. Record coverage of simultaneous submissions/order, queued actions, timer/resolve races, reconnect, host controls, moderation/chat isolation, combat turn/reaction behavior, and spotlight. Preserve the command, commit SHA, test totals, and output as a report or CI artifact. | **Partial.** M4 item 9's six-client harness and 10 scenarios merged in [#272](https://github.com/cjkennedy1972/lorekeep-dm/pull/272); its recorded run is 10/10, including ordering, race/queue, reconnect, host actions, moderation/chat isolation, revoked-seat access, and six players × ten turns. The follow-up combat-specific simulation cases (reaction timeout, reconnect mid-prompt, combat narration isolation, host revoke during combat) remain open on Workboard card `8d76f62b`; no consolidated M4 exit report exists yet. |
| **Real 3–4 person playtest including combat on the map** | Dated playtest record with 3–4 participants, exact build/commit, quick-start through map combat (movement, reaction/opportunity attack, area aim), observations, findings, and disposition/follow-up links. | **Not met.** Workboard card `d102b722` tracks the playtest and evidence record; it explicitly needs Chris to arrange players. No playtest artifact or PR is present. |
| **Spotlight measured** | Event-log-derived metric for a six-player, ten-turn run showing at least one direct prompt to each active, non-idle player; retain the event-log input, calculation, result, and exact run/build. | **Met for the scripted gate.** PR [#272](https://github.com/cjkennedy1972/lorekeep-dm/pull/272) records the event-log metric: six active players, ten direct prompts each, none unspotlit. The metric implementation and presence/spotlight behavior also shipped in [#278](https://github.com/cjkennedy1972/lorekeep-dm/pull/278). Preserve/link the exact run output in the eventual M4 exit report. |
| **Keyboard-only combat passes** | Reproducible browser/E2E or witnessed checklist against the web client proving keyboard-only quick-start combat completes movement, attack, reaction, and area aim; include focus/selection and list-driven equivalents, exact build, and result. | **Not met / unverified.** No keyboard-only combat evidence is in the plan reports or merged PR record. The remaining map-UI hardening card `75a5f8b1` covers map interaction and party-combat E2E; no evidence currently proves the full keyboard-only combat path. |

## Scope and interpretation

- The M4 breakdown items 0–5 have merged implementations (see PRs #263, #266, #268, #271/#274/#281, #278, and #273 respectively), but item-level implementation does not by itself satisfy these four milestone exit gates.
- Item 6 is partial: phase admission, lifecycle events, and movement/reaction continuation shipped in #307–#309; single-turn narration lifecycle remains draft in #310.
- Item 7 is missing a dedicated Workboard task. M1/M2 already provide the engine reference/path movement and area-target tools and deterministic monster policy; M4 still needs the production Room bridge from authoritative `combatRoom` state into those DM tools and persisted results. See new card `252ee21b`.
- Item 8 remains open; the host-control UI PRs do not prove the complete accessible map-combat path.
- Item 9 has a green baseline simulation and a measured spotlight result, but the combat-specific simulation additions and real playtest are still outstanding.

## Evidence index

- Architecture criteria: `docs/architecture.md` §11.
- Work item acceptance detail: `docs/plan/m4-breakdown.md`.
- Six-client harness and recorded baseline: [PR #272](https://github.com/cjkennedy1972/lorekeep-dm/pull/272).
- Presence/autopilot/spotlight implementation: [PR #278](https://github.com/cjkennedy1972/lorekeep-dm/pull/278).
- Current missing M4 evidence/tasks: Workboard `8d76f62b` (combat simulation), `d102b722` (real playtest), and `75a5f8b1` (map UI / combat E2E).
