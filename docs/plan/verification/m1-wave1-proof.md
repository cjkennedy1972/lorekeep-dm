# M1 wave 1 and invite follow-up: independent verification

Verifier: proof, fresh clone of origin/main at `ad4fc45`, 2026-10-06. macOS arm64, node v26.10.0, pnpm 12.9.1, Docker 29.4.0 (own Postgres 16.10 on 127.0.0.1:55460). No product code edited.

## Gate on ad4fc45 (docs/process.md), all exit 0
`pnpm install --frozen-lockfile`, `pnpm -r typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm -r test` (schema 79, engine 24, server 60, web 96, e2e 4), `migrate:up`, `@game/server test:db` (32), `pnpm --filter e2e test` (4), `pnpm -r build`, Playwright chromium (10 passed).

## A) Card 316f34f0, commit f39dfb0: invite regeneration after reload
Live script: `docs/plan/verification/invite-live-check.mjs` against the real `node dist/main.js` (port 3461) and the real Postgres. 20/20 checks PASS.
Setup caveat: signup is real HTTP, but accounts were activated by a direct `UPDATE accounts SET status='active'` because the server's ConsoleEmailSender never exposes the verify token.

What the design actually does:
- Create returns the plaintext code once (201). `GET /api/rooms`, `GET /api/rooms/:id` never return it, including in a new login session of the same host (the "reload").
- Host in the new session calls `POST /api/rooms/:id/invite` -> 200 and a new code. The old code then gets 404 `INVITE_INVALID`. Before regeneration the old code worked (a joiner seated through it keeps the seat; regeneration does not unseat anyone).
- Joiner with the new link is seated once: `/api/join/:code` twice and `/api/invites/:code/join` once give 1 `SeatJoined` event for that account.
- Seated non-host: POST and DELETE on `/invite` -> 403 FORBIDDEN. Unseated outsider -> 404 (no existence leak). Anonymous -> 401.
- DB: only invite column is `sessions.invite_hash` (64 hex sha256). Neither the old nor the new plaintext appears in any row of any public table (`t::text LIKE` scan). Host DELETE revokes; join afterwards -> 404.
- UI side (not exercised live here): web test in `apps/web/src/screens/screens.test.tsx` and the Playwright e2e passed in the gate.
Observation (minor, not a defect in this card): the route requires an empty body without a `content-type: application/json` header; a client that sends that header with no body gets 400 `FST_ERR_CTP_EMPTY_JSON_BODY`. The web client passed its tests, so it evidently does not.

## B) M1-01..03 acceptance mapping
Suites run: engine 24/24, schema 79/79 pass. `grep -rnE "Math\.random|\bDate\b|performance\.now" packages/engine/src` -> no matches.
Commits: 66e4e56 (M1-01), 9ebb3c7 + 89118fa (M1-02, lint fix), dbb05d2 (M1-03).

| Task | Acceptance bullet | Proof | Status |
|---|---|---|---|
| M1-01 | Same seed and inputs give identical rolls | `packages/engine/test/dice.test.ts` "determinism > same seed and inputs give identical rolls" | PROVEN |
| M1-01 | Adv/disadv lists both dice, marks dropped | dice.test.ts "advantage/disadvantage > lists both dice and marks the dropped one" (50 seeds x 2 modes; also checks kept>=dropped / <=) | PROVEN |
| M1-01 | total = kept dice + labelled modifiers, 1000 runs | dice.test.ts "total equals kept dice plus labelled modifiers (1000 runs)". Seeded loop over 5 expressions, not a property-test library; satisfies "1000 runs" | PROVEN |
| M1-01 | No Math.random or Date in engine src | dice.test.ts "no Math.random or Date in src" (recursive over src, includes catalog/) plus my independent grep: none | PROVEN |
| M1-02 | Every schema parses valid, rejects invalid, per kind | `packages/schema/test/m1-schemas.test.ts`: catalog `test.each` over all 7 kinds (species, class, background, equipment, spell, monster, condition) incl. missing catalogVersion, non-SRD source, unknown kind; "Character parses valid and rejects invalid"; "CombatState parses valid and rejects invalid"; events `test.each` over all 15 types (parse + reject bad payload) | PROVEN (rejection cases for Character/CombatState are one or a few cases, not a table) |
| M1-02 | Event union discriminated and exhaustively switchable (compile-time) | `label()` switch with `never` default in m1-schemas.test.ts; discrimination covered by the events tests | PARTIAL: the compile-time check is not enforced by any gate. `packages/schema/tsconfig.json` has `include: ["src"]`, so `pnpm typecheck` never compiles the test file and vitest does not typecheck. Mutation: deleting `case 'SlotSpent'` still passes `pnpm typecheck` (rc 0); only `tsc` run on the test file reports TS2322. Adding a new event to the schema without a case also goes unnoticed. DEFECT (test-gap) |
| M1-02 | Catalog entries carry id, catalogVersion, srd source | m1-schemas.test.ts "rejects $kind missing catalogVersion" and "rejects $kind with non-SRD source" (id required by valid fixtures) | PROVEN (id-missing rejection is not a separate case) |
| M1-02 | No runtime dependency from @game/schema on engine or apps | No test. By inspection: `packages/schema/package.json` dependencies = zod only; no cross-package imports in src | UNPROVEN by test (verified by inspection only) |
| M1-03 | Loader fails with file+id message on invalid entry | `packages/engine/test/catalog-load.test.ts` "schema-invalid entry reports file and id" | PROVEN |
| M1-03 | Duplicate ids across files rejected | catalog-load.test.ts "duplicate ids across files are rejected" | PROVEN |
| M1-03 | catalogVersion identical across runs, changes on any entry change | catalog-load.test.ts "catalogVersion is stable and changes with content" (also order/file-split invariance; one changed entry) | PROVEN |
| M1-03 | Spell level 4 and CR 6 fail to load | catalog-load.test.ts "scope gate: spell level 4 and CR 6 fail, level 3 and CR 5 load" | PROVEN |

Not covered by the acceptance list and not verified here: class level gating (L1-5) in the loader, the engine/schema artifacts for events beyond their parse shape, and the `@game/rules-engine` verify filter name (it exists as the package name; used as written).

## Unverified
Live UI click-through of the lobby regeneration button (only the unit and Playwright suites); CI result for this commit (see below).
