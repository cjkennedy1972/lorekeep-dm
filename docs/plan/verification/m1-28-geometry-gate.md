# M1-28 geometry gate verification

- Gate: `pnpm --filter @game/rules-engine test:geometry` — PASS, exactly 100/100 named cases across movement cost, reach, range, cover and AoE.
- Properties: six fast-check properties, each configured for 500 generated runs: path/reachable cost agreement, LOS symmetry, distance metric laws, AoE translation/count invariance, RLE round-trip, and seeded RNG replay determinism.
- Mutation check: temporarily changed the `5ft` diagonal distance branch from Chebyshev steps to `steps + diag`, then ran `pnpm --filter @game/rules-engine exec vitest run test/geometry-gate.test.ts`. The deliberately broken diagonal rule failed 20 named reach cases (80/100 passed); the original source was restored immediately. This is a test-sensitivity check, not an implementation change.
- Geometry defects found: none. The new path/reachable property passes for the generated open-map cases.
