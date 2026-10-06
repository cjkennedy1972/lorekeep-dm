# ADR-018: Tactical battle map state owned by the rules engine; LLM references map entities by ID only

Status: Proposed (human decision 2026-10-06: graphic battle map replaces theater-of-mind) · Date: 2026-10-06 · Supersedes the range-band positioning in ADR-005

**Context.** Combat becomes a tabletop-style map with minis and terrain. Positions, movement, range, line of sight, cover, areas of effect, and opportunity attacks all affect numbers, so they belong to the pure rules engine (ADR-004), not the LLM or the client.

**Decision.**
- **Grid:** square, 5 ft cells (hex out of scope). Map size cap 60x60 (assumption). `diagonalRule` is a map-level constant (default: each diagonal costs 5 ft) to be checked against SRD 5.2.1 text **[unverified]**.
- **Map state** (in snapshots; terrain RLE-encoded): `Battlemap{mapId, w, h, palette[{terrainId, moveCost, blocksMove, blocksSight, cover: none|half|three-quarters|full, elevation}], cells (palette indexes), edges (walls, doors: open/closed/locked, windows), features[{featureId, kind, cells, tags}], markers[{markerId, cell, label}], zones (spawn, light level)}`. Entities in combat carry `pos{x,y,elevation}` and `size` (footprint in cells).
- **Engine functions** (pure, deterministic, shared with the client for previews): `reachable(state, entityId)` (cost-aware, occupancy-aware flood), `path(state, entityId, goal)`, `distance(a, b)`, `hasLineOfSight(a, b)` (cell-corner trace; the algorithm is ours, documented, and tested), `coverBetween(a, b)` (blocked-line count to cover grade), `areaCells(template, origin, direction)` (sphere/cube/cone/line/cylinder rasterization; spreads around corners by flood from origin), `threatenedBy(entityId)`, `describe(state, viewerId, verbosity)` (deterministic text for accessibility and LLM context).
- **Movement is a multi-step command** resolved cell by cell: speed, difficult terrain, prone/grappled/restrained, squeezing, ally pass-through, no ending on occupied cells. **Opportunity attacks:** when a step leaves a hostile's reach without Disengage or forced movement, the engine pauses the path and emits `ReactionAvailable{opportunityAttack}`; the 15 s reaction window (ADR-005) runs; the path then resumes if the mover is still legal to move.
- **Who supplies coordinates:** player UI commands (click, keyboard) are structured client input validated by the engine, not LLM output. **The LLM never supplies raw coordinates.** Its map tools take engine-issued handles only: `entityId`, `featureId`, `markerId`, or `optionId` from an engine-returned list. Examples: `move_to(entityId, targetRef, mode: adjacent|within|retreat|cover)`, `attack(attackerId, targetId, attackId)`, `cast_spell(..., target{kind: entity|anchor|suggested, ref})`, `suggest_area_target(spellId, casterId, intent: most_enemies|avoid_allies)` returning `optionId`s. Unknown handles are rejected; the engine does the pathfinding and placement.
- **Monster policy** gains pathfinding (A*), range preference, cover seeking, flee; still deterministic, still no LLM (ADR-004).
- **Visibility:** MVP shares full vision except entities flagged `hidden`; clients receive a per-viewer projection so fog of war (spec P2) can be added without a protocol change.
- **Events:** `MapLoaded`, `EntityPlaced`, `EntityMoved{path, cost}`, `OpportunityTriggered`, `AreaResolved{cells, affected[]}`, `TerrainChanged`, plus map facts inside `AttackResolved` (cover, distance).

**Alternatives.** Range bands (previous; rejected by decision). Client-owned positions (cheating, drift). LLM-supplied coordinates (hallucinated, injectable; rejected). Hex grid (more rules, no SRD benefit).

**Consequences.** Largest new engine module (about 3 weeks of M1). Spec §4.4, A5, and the non-goal "battle-map tactical VTT" need amending (fog of war stays out). Property tests cover movement cost, LOS symmetry, cover, and AoE shape counts.

**Needs human?** Confirm the diagonal-movement convention and the 3 area shapes to ship first.
