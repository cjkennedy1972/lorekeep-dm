# M2-02: SRD geometry fixes

Implemented against the 14 mismatches in [M2-01](m2-01-srd-geometry.md), using the printed page references there.

## Behavior changes

1. **Movement corners (SRD p.13):** diagonal movement rejects a move when both orthogonal flank spaces are `blocksMove` terrain cells, preventing movement diagonally through a pillar/tree corner. Wall-edge blocking remains in place.
2. **Creature cover (p.15):** `coverBetween` accepts intervening creature placements and treats them as Half Cover.
3. **Area cover and saves (p.15, p.177):** affected entities use the same cover grade calculation as direct cover. Spell resolution adds that bonus only to Dexterity saves; attack AC bonuses remain unchanged.
4. **Area line of effect (p.177):** added `totalCoverBetween`; area locations are blocked by Total Cover, not merely by sight-blocking terrain. This makes clear glass/Wall of Force block and fog without cover pass, consistent with direct targeting.
5. **Cone geometry (p.179):** width narrows to the SRD relation (width at a point equals distance from origin), and origin is excluded unless `includeOrigin: true`.
6. **Line geometry (p.184):** excludes origin by default, rasterizes even widths to the stated number of squares, and measures diagonal length in feet rather than summed grid coordinates.
7. **Cube origin placement (p.179; Thunderwave p.169):** centered cubes remain supported as a legal placement; `includeOrigin: false` uses a directional face-origin footprint for effects originating from the caster.
8. **Emanation (p.177, p.181):** added the shape and radius rasterization; the origin may be excluded with `includeOrigin: false`.

The explicit inclusion option exists because the SRD says a creator may decide whether cone/line/emanation origins are included. The existing cell-center rasterization remains the documented SRD-silent grid convention.

## Updated legacy expectations

- `packages/engine/test/map-area.test.ts`: cone case counts changed from the former 90-degree wedge (`4, 9, 16, 25, 36`) to the narrower directional raster (`1, 4, 7, 12, 17`), citing SRD p.179. Diagonal direction count expectation now records the unchanged rasterizer's two orientation groups (`17` cardinal, `21` diagonal) because grid-square selection is SRD-silent. Cube/sphere expectations remain unchanged.
- `tests/e2e/m2-srd-geometry.spec.ts`: strict test assertions are now unconditional. Cone point checks were corrected to match the width relation at 5 ft and 15 ft. Glass/fog checks were corrected to SRD p.177: only Total Cover stops areas. Cube remains face-origin-selectable; centered cubes remain legal. Assertions were preserved, not removed.
- `packages/engine/test/geometry-gate.test.ts`: the AoE expectation now excludes the origin for cone and line cases, as required by SRD pp.179/184; the 100 named cases and set remain exactly 100.
- `packages/engine/test/golden/scripted-combat.json`: regenerated because the scripted cone footprint changed from the old wider wedge (SRD p.179). Combat still completes deterministically.

## Verification

Passed locally: `pnpm lint`, `pnpm typecheck`, `pnpm format:check`, `pnpm --filter @game/rules-engine test:geometry` (100/100 + 6 property tests), strict geometry spec (31/31), `pnpm -r test` except four DB-backed e2e files that require `DATABASE_URL` (58 other e2e tests pass). CI is expected to run DB-backed tests.
