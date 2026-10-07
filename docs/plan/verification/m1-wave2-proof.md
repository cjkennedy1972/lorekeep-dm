# M1 wave 2 independent verification: M1-04, M1-17

Verifier: proof. Fresh clone `/tmp/proof-w2` at origin/main `f8758e0`. Date 2026-10-06.
Tools: node v26.10.0, pnpm, git, gh all present.

## Gate (fresh clone)
| Command | Exit |
|---|---|
| `pnpm install --frozen-lockfile` | 0 |
| `pnpm -r typecheck` | 0 |
| `pnpm lint` | 0 |
| `pnpm format:check` | 0 |
| `pnpm -r test` | **1** (only `tests/e2e`: 4 files fail with "DATABASE_URL is required"; no Postgres/DATABASE_URL in this environment. schema 79/79, engine 24/24, server 60/60 pass) |
| `pnpm -r build` | 0 |
| `pnpm --filter @game/schema test` | 0 (79 passed) |
| `pnpm --filter @game/rules-engine test` | 0 (24 passed) |

The e2e failure is an environment gap (no DB), not a code finding. It is unverified here. Playwright e2e was not run.

CI (`gh run list`): CI = success for b81feeb, ad4fc45 and f8758e0.

## M1-04 (b81feeb): PASS
Artifacts all exist: `packages/engine/catalog/{species,backgrounds,equipment,conditions}.json`, `packages/engine/test/catalog-v0-content.test.ts` (plus `catalog-v0-expected-counts.json`).
| Acceptance | Evidence |
|---|---|
| Loads via M1-03 loader | `catalog-v0-content.test.ts` calls `loadCatalog()` at module load; 4 tests pass |
| Counts match checked-in expected-counts | test "counts match expected-counts file"; file: species 9, background 4, condition 15, weapon 36, armor 13, gear 16 |
| Backgrounds: ability options + two skills | test asserts 3 abilityOptions and 2 skillProficiencies for each |
| Condition ids resolve | test checks `conditionRefs` of species resolve. Note: it only walks species refs; equipment/background refs are not covered (none were checked for existence) |

SRD 5.2.1 spot-check from my knowledge, not open-ended research: species 9 (Dragonborn, Dwarf, Elf, Gnome, Goliath, Halfling, Human, Orc, Tiefling), 4 backgrounds, 15 conditions, 13 armor entries including Shield, and 36 weapons are consistent with the SRD lists. I did not diff the entries field by field; nothing shown wrong. Content was authored from memory, so item-level stats (costs, weights, damage) remain unverified against the SRD text.

## M1-17 (ad4fc45): PASS, with one robustness defect
Artifacts exist: `packages/schema/src/battlemap.ts`, `packages/engine/src/map/validate.ts`, `packages/engine/test/map-validate.test.ts` (plus `packages/schema/test/battlemap.test.ts`).
| Acceptance | Evidence |
|---|---|
| RLE round-trip, 200 random maps | `battlemap.test.ts` "round-trips 200 random grids" (seeded LCG, len up to 3600), pass |
| 60x60 under 20 KB | `map-validate.test.ts` first test: valid and `JSON.stringify(...).length < 20000`, pass |
| Specific error code per defect class (5 bad fixtures) | tests for DIMENSION_MISMATCH, BAD_PALETTE_INDEX, UNKNOWN_ID, DOOR_NOT_ON_EDGE, EDGE_OUT_OF_BOUNDS (5 fixtures), pass |
| 61x61 rejected | test asserts SCHEMA_INVALID; I also confirmed 61x60 rejected |

### Adversarial inputs (ad hoc vitest file, not committed)
| Input | Result |
|---|---|
| odd-length rle `[0,4,0]` | DIMENSION_MISMATCH |
| 3 or 5 cells for 2x2 (off-by-one) | DIMENSION_MISMATCH |
| negative run `[0,-4]`, w=0, null | SCHEMA_INVALID |
| door with no state / wall diagonal edge | DOOR_STATE_INVALID / DOOR_NOT_ON_EDGE |
| 60x60 exactly | ok |
| zero-length run `[0,0,0,4]` | **accepted as ok** (non-canonical, decodes correctly) |
| single run of 200,000,000 (`[0,200000000]`) | **`validateBattlemap` THROWS `RangeError: Invalid array length`** after ~0.9 s |

Defect (low/medium, not a ticket acceptance failure): the `DIMENSION_MISMATCH` message calls `rleDecode(rle).length`, which materialises the whole decoded array. Hostile input with a huge run makes the validator throw (or exhaust memory with larger values) instead of returning an error, which matters if maps are uploaded or come from an LLM. Suggested fix: use the already computed `total` in the message. Also consider rejecting zero runs, and capping `cells` length. `rleDecode` itself has no bound and silently ignores a trailing odd element and negative runs.

## Uncertainty
- Playwright and DB-backed e2e not run (no DATABASE_URL).
- SRD content accuracy checked only at list and count level.
- Verified at f8758e0, not later.
