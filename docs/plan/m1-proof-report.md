# M1 exit-criteria proof report (M1-42)

Date: 2026-10-08. Proof suite: `tests/e2e/m1-geometry-gate.spec.ts`, `m1-scripted-combat.spec.ts`, `m1-legal-pcs.spec.ts`, plus the existing Playwright `apps/web/e2e/sandbox-combat.spec.ts`.

Base: origin/main `581d267` (M1-41). Fresh-clone runs below are of branch `feat/m1-42-exit-proof` at `6e0d1ec` (main + this ticket), cloned from GitHub into `/tmp/lorekeep-fresh`, outside any agent workspace. They are not of bare origin/main, because the proof specs only exist on the branch; after merge, re-run on main.

## Fresh-clone full gate (docs/process.md)

Environment: node v26.10.0, pnpm 12.9.1, macOS arm64. `DATABASE_URL=postgres://lorekeep:lorekeep@127.0.0.1:5432/lorekeep` pointed at the already-running local `postgres:16.10-alpine` container; the e2e harness only creates and drops uniquely named disposable databases.

| Command | Exit | Notes |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | 0 | |
| `pnpm -r typecheck` | 0 | |
| `pnpm lint` | 0 | |
| `pnpm format:check` | 0 | |
| `pnpm -r test` | 0 | schema 89, server 60, engine 351, web 135, tests/e2e 31 (7 files, incl. the 3 new specs and the 4 M0 DB specs) |
| `pnpm -r build` | 0 | |
| `pnpm --filter @game/web exec playwright install chromium` | 0 | |
| `pnpm --filter @game/web exec playwright test` | 0 | 12 passed |
| `pnpm --filter @game/rules-engine test:geometry` | 0 | `Geometry gate: 100/100 passing`; 2 files, 106 tests |

An earlier fresh-clone run of the first commit (`d96f598`) was red (typecheck, build, engine purity test, 11 web test files, all Playwright). Root cause was my own change: I exported `scenario-crypt` (uses `node:fs`/`import.meta.url`) from the browser-safe engine index. Fixed in `6e0d1ec` by exposing it only via a node-only subpath `@game/rules-engine/scripted-node` (same pattern as `catalog-node`), and by giving `tests/e2e` a `pretypecheck` that builds schema and engine. Existing tests were not changed.

## Exit criteria

| # | Criterion | Command | Result | Gap |
| --- | --- | --- | --- | --- |
| 1 | Geometry gate 100/100 and property suite | `pnpm --filter @game/rules-engine test:geometry`; also asserted from `m1-geometry-gate.spec.ts`, which runs that command as a child process and checks exit 0, `100/100`, 2 test files passed | PASS: 100/100 named cases, 6 fast-check properties at 500 runs each, exit 0 | Gate content is the M1-28 suite; the spec only proves it runs and reports. |
| 2a | Scripted solo combat, no LLM: OpportunityTriggered, AreaResolved with >=2 affected, ends CombatEnded, reproducible by seed | `pnpm --filter e2e exec vitest run m1-scripted-combat` | PASS (4 tests). Seed 2901 yields 25 events: CombatStarted, moves, 2x OpportunityTriggered, ReactionResolved, SpellCast, AreaResolved (affected `goblin-1`, `goblin-2`), CombatEnded (last, exactly once). Second run is byte-identical JSON; `replayCryptCombat` reproduces the final state; seed 7 also terminates in CombatEnded | Engine-level only. The scenario is one authored 3-entity crypt fight (wizard vs two goblins). |
| 2b | Same flow in the web sandbox by keyboard, ends CombatEnded, no non-static requests | `pnpm --filter @game/web exec playwright test` (`sandbox-combat.spec.ts`) | PASS (12/12 in the suite). Test records every non-static request and asserts the list is empty | Chromium only; no other browsers or screen readers. "No LLM" is shown by the empty request list and by the existing `scripted-combat.test.ts` import scan, not by a network sandbox. |
| 3a | 12/12 classes quick-build legal | `m1-legal-pcs.spec.ts`: `quickBuild` x 3 seeds per class, then real `validateCharacter` | PASS: 12 class ids found in catalog, 36 builds, 0 violations | Level 1 only. Quick-build output is validated by the same module family that builds it. |
| 3b | 5 illegal fixtures rejected with codes | same spec; each fixture mutates a validated legal wizard | PASS: `POINT_BUY_TOTAL`, `ASI_NOT_ALLOWED`, `BACKGROUND_SKILL_COUNT`, `SPELL_NOT_ON_CLASS_LIST`, `UNKNOWN_CLASS` each returned; baseline fixture asserted violation-free first | Five of the validator's codes only; others (e.g. `WRONG_EQUIPMENT`, `STANDARD_ARRAY`) are covered by existing engine tests, not re-proved here. |
| 4a | Catalog scope gate | same spec, real `loadCatalog` on temp dirs | PASS: spell level 4 and CR 6 throw; level 3 and CR 5 load; shipped catalog has no spell above 3 and no monster above CR 5 | |
| 4b | `catalogVersion` hash | same spec | PASS: 64-hex sha256 `57dea489d08d81d6de060f7c765e5ccb979b15d4f9e7d460edd501861871df37` for the shipped catalog; stable across loads, equal to `catalogVersionOf(entries)`, order-independent, changes when one entry changes | The hash value is recorded for reference only and is not asserted as a literal, so it changes legitimately with content. |

Shipped catalog counts at this commit: 4 backgrounds, 12 classes, 12 subclasses, 15 conditions, 65 equipment, 242 monsters, 9 species, 183 spells.

## Remains unverified

- **Diagonal rule vs SRD.** The gate checks the engine against its own `5ft` rule (Chebyshev steps); the 100 cases were written by the same team. Not compared with the SRD 5.2.1 text or an independent implementation.
- **Monster and spell coverage vs SRD counts.** Counts above are what the catalog contains. They were not reconciled against the SRD list (monsters CR 0-5, spells level 0-3), so omissions are possible. Entry stats were not diffed against SRD text.
- **DB-backed tests in CI.** Run locally here against a pre-existing Postgres container using disposable databases; GitHub CI is the authoritative run (see PR checks).
- Browser coverage beyond Chromium; assistive-tech behaviour of the sandbox; combat scenarios other than the authored crypt; levels above 1 for quick-build.
- Test-sensitivity: the new specs passed on first run for criteria 2-4. I did not mutation-test them (the geometry gate has its own mutation check in `docs/plan/verification/m1-28-geometry-gate.md`).
