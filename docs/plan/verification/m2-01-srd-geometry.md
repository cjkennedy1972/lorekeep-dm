# M2-01: SRD 5.2.1 geometry conformance

Date: 2026-10-08. Checked by proof against engine commit 8c17087 (`origin/main`).

## Source

`SRD_CC_v5.2.1.pdf`, the official CC-BY 4.0 file (https://media.dndbeyond.com/compendium-images/srd/5.2/SRD_CC_v5.2.1.pdf, 364 pages, Last-Modified 2025-05-01), read as extracted text. Page numbers below are the printed page numbers in that PDF. Rule text was compared with the engine's behaviour by running the real engine (`tests/e2e/m2-srd-geometry.spec.ts`), not by comparing the engine with its own tests.

Result values: **MATCH**, **MISMATCH**, **SRD-SILENT** (the SRD gives no rule; the engine's documented convention stays, which is the ticket's "NOT VERIFIABLE").

## Results

| # | Rule | SRD text (page) | Engine | Result |
|---|---|---|---|---|
| 1 | Default diagonal cost | p.13 "Playing on a Grid": each square is 5 ft; "It costs 1 square of movement to enter an unoccupied square that's adjacent to your space (orthogonally or diagonally adjacent)". A diagonal is 5 ft. | `cellDistance` default and `Battlemap.diagonalRule` default are `5ft`; `reachable` charges 5 ft per diagonal step | **MATCH** |
| 2 | 5-10-5 `alternate` variant | Not in the SRD. The SRD names no variant diagonal rule. | `diagonalRule: 'alternate'` in `geometry.ts` | **SRD-SILENT**: keep as an optional house variant, default stays `5ft` |
| 3 | Difficult Terrain | p.13: "A square of Difficult Terrain costs 2 squares to enter." | `moveCost: 2` terrain charges 10 ft | **MATCH** |
| 4 | Range counting | p.13 "Ranges": count squares from a square adjacent to one of them, stop in the other's space, shortest route. | `distance()`: adjacent = 5 ft, Chebyshev, footprint minimum | **MATCH** |
| 5 | Corners | p.13 "Corners": "Diagonal movement can't cross the corner of a wall, a large tree, or another terrain feature that fills its space." | Wall *edges* block diagonal corner crossing (MATCH). A terrain *cell* that fills its space (`blocksMove`, e.g. pillar/tree) does not: only the destination cell is checked in `movementNeighbors` | **MISMATCH** (terrain cells) |
| 6 | Cover grades and bonuses | p.15 Cover table, p.179 glossary: Half +2 AC and Dex saves, Three-Quarters +5, Total cannot be targeted directly. | `coverBetween`: half +2, three-quarters +5, full = not targetable | **MATCH** |
| 7 | Multiple cover sources | p.15: only the most protective degree applies, degrees are not added. | Strongest grade on the clearest ray | **MATCH** |
| 8 | Creatures give cover | p.15 table: Half Cover is offered by "Another creature or an object that covers at least half of the target". | `coverBetween(map, a, b)` takes no entities; creatures never give cover | **MISMATCH** |
| 9 | Cover for area effects (saves) | p.15: cover applies when the effect "originates on the opposite side of the cover"; p.177 points at Cover for areas. | `area.ts` `coverBonus` reads only the palette cover of the target's own square, ignoring obstacles between origin and target. A crate between a Fireball and its target gives 0; a target standing on a cover square gets it from any direction | **MISMATCH** |
| 10 | Cover bonus applies to Dexterity saves only | p.15, p.179: "+2 bonus to AC and Dexterity saving throws". | `spells.ts` adds `affected.saveBonus` to every save ability (observed: Con save for Stinking Cloud is +2 higher on a half-cover square) | **MISMATCH** |
| 11 | Clear path to a target | p.106 "Targets": "a caster must have a clear path to it, so it can't be behind Total Cover." | Spells and attacks reject `targetable: false` (full cover, walls, closed doors) | **MATCH** |
| 12 | Area blocked locations | p.177 "Area of Effect": a location is excluded only if all straight lines from the point of origin to it are blocked, and "an obstruction must provide Total Cover". | Rays are tested with `hasLineOfSight`, which is driven by `blocksSight`, walls and doors, not by Total Cover. A glass/Wall-of-Force square (`cover: full`, `blocksSight: false`) does not stop an area but stops targeting; a fog square (`blocksSight: true`, `cover: none`) stops an area though it gives no cover. Straight-line behaviour around a solid pillar line matches | **MISMATCH** (blocking criterion); behind a solid blocker **MATCH** |
| 13 | Origin placed at an unseen point | p.177: point of origin forms on the near side of the obstruction. | `areaCells` takes the origin as given; no caster-aware placement | **SRD-SILENT at this layer**: not testable without a caster/placement API (M2-02 to decide) |
| 14 | Sphere | p.188: extends from the point of origin in all directions by the radius; origin included. | Euclidean radius from the origin square, origin included | **MATCH** (rule); square selection is **SRD-SILENT** (see 20) |
| 15 | Cylinder | p.180: radius and height, origin at the centre of the base, included. | Same as a Sphere in plan; `height` ignored | **MATCH** in plan view; vertical extent **not verifiable** on the 2-D map |
| 16 | Cube | p.179: size is each side; the origin is "located anywhere on a face of the Cube" and is not included unless the creator decides. Thunderwave (p.169) is a "15-foot Cube originating from you". | Side length is right (15 ft = 3 squares). The cube is always centred on the origin, so a caster-origin cube contains the caster and extends behind them | side **MATCH**; origin placement **MISMATCH** |
| 17 | Cone | p.179: width at any point equals its distance from the origin (15 ft wide at 15 ft); origin not included unless the creator decides. | Maximum length is right. The wedge is 90 degrees (width = 2 x distance), twice the SRD width; the origin is always included | length **MATCH**; width **MISMATCH**; origin **MISMATCH** |
| 18 | Line | p.184: runs from the origin along its length with the stated width; origin not included unless the creator decides. | Origin is included (Lightning Bolt, 100 ft, covers 21 squares); a 10-ft wide line is 3 squares wide; a diagonal line measures distance as dx+dy and is cut to half length (about 10 squares for 100 ft) | **MISMATCH** (origin, even widths, diagonal length); 5-ft wide orthogonal length otherwise **MATCH** |
| 19 | Emanation | p.177 lists six shapes; p.181: extends from a creature or object in all directions by the stated distance, moves with it, origin creature not included unless the creator decides (Aura of Protection, Spirit Guardians). | No `emanation` shape in `AreaShape`; unknown shapes select no cells | **MISMATCH** (missing shape). The ticket and plan name five templates; SRD 5.2.1 has six |
| 20 | Rasterizing templates onto squares | The SRD defines shapes geometrically and gives no square-selection rule (p.13 covers movement and range only). | Square-centre-inside convention documented in `area.ts` and pinned by `packages/engine/test/map-area.test.ts` | **SRD-SILENT**: keep the convention |
| 21 | How cover is measured | p.15: "The GM determines whether the target has Cover". No ray or corner algorithm. | Cell-centre rays, clearest ray wins | **SRD-SILENT**: keep the convention |
| 22 | Doors and windows as cover/blockers | Not defined in the SRD. | Closed/locked doors act as walls; windows transmit sight and give no cover | **SRD-SILENT**: keep the convention |

## Mismatch list for M2-02

14 mismatch tests cover the MISMATCH rows. Each is skipped by default and fails today when enabled with `M2_SRD_STRICT=1` (checked: 14 failed, 17 passed, 0 skipped in strict mode; 17 passed, 14 skipped in the default run). Each failure was read and is for the stated reason.

1. Diagonal movement crosses the corner of a `blocksMove` terrain cell (row 5).
2. Creatures do not give Half Cover (row 8). The test passes entities as a fourth argument; M2-02 defines the real signature and should adapt the test.
3. Area cover ignores an obstacle between origin and target (row 9).
4. Area cover bonus is added to non-Dexterity saves (row 10; Con save differs by exactly +2 on a half-cover square).
5. Area blocking uses sight, not Total Cover: glass (Total Cover, clear) does not block (row 12).
6. Fog (blocks sight, no Total Cover) does block (row 12).
7. Targeting and area inclusion disagree on glass (row 12).
8. Cone is twice the SRD width (row 17).
9. Cone includes its origin (row 17).
10. Line includes its origin (row 18).
11. Even Line widths are one square too wide (row 18).
12. Diagonal Line length is about half (row 18).
13. Cube is centred on the origin (row 16).
14. No Emanation shape (row 19).

## Judgement calls

- Row 16 (Cube): the SRD allows the origin on any face, including the top or bottom, which in plan view puts it inside the footprint. So a centred cube is one legal placement. The mismatch is that the engine cannot express an origin on a vertical face, so Thunderwave (which originates from the caster) wrongly includes the caster and extends behind. M2-02 may reasonably resolve this by adding a placement argument rather than changing the default.
- A removed test: I considered "cover must not depend on which end holds the cover square" and dropped it, because the SRD does not say where cover inside the target's own square counts (SRD-SILENT).
- A single pillar directly between two 1-square creatures counts as Total Cover in the engine. The SRD leaves that to the GM (row 21), so I did not test it.

## Decision item

`docs/decisions.md` open item "Diagonal movement convention (M1-18)": **resolved**. SRD 5.2.1 p.13 makes a diagonal step cost 1 square (5 ft), matching the engine default. The 5-10-5 variant is not in the SRD (row 2) and stays an opt-in house variant.

## Not verified

- Anything beyond text: the SRD is read as extracted PDF text; table layout (Cover table) was read from the extracted cells and matches the glossary entry on p.179.
- Vertical extent (Cylinder height, Cube/Sphere in 3-D), flying and elevation: the engine map is 2-D.
- Size-related cover rules for Large and bigger targets, and how many rays should be required for "covers at least half" (SRD-SILENT, row 21).
- Spell-by-spell template data in the catalog (that each spell uses the right shape and size) is M2-03.
