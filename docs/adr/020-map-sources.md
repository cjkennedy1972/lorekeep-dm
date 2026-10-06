# ADR-020: Map sources: authored per adventure (MVP), procedural templates (stretch), user upload (later)

Status: Proposed (default) · Date: 2026-10-06

**Context.** Maps come from three sources. The engine needs semantic data (walls, cover, terrain), not just pictures.

**Decision.**
1. **Authored (MVP):** each adventure ships maps as schema-validated JSON (grid, palette, edges, features, markers, spawn zones). Encounters reference `markerId`/spawn zones, never coordinates. Authoring in a map editor (Tiled's JSON export is a candidate **[unverified]**) with a converter that validates and fails the build on bad data (unreachable spawns, blocked exits, unknown palette IDs). Maps are catalog-class content, versioned and hashed.
2. **Procedural (stretch, M5):** deterministic generators (rooms-and-corridors, cave cellular automata, open-field scatter) take `{theme, size, seed}`. The LLM may call `generate_encounter_map(theme: enum, size: enum)` only; the seed is logged for replay. The engine validates connectivity (flood fill) and spawn feasibility and regenerates on failure. The LLM cannot draw or edit cells.
3. **User upload (later, Phase 2):** image upload (PNG/JPEG/WebP, size and pixel caps), EXIF stripped and re-encoded, image moderation before first display, content-hash dedupe. An image has no semantics, so the upload flow includes a **calibration and annotation editor**: set grid size and offset, draw wall/door/cover segments. A map is unusable for combat until annotation validates. Private to the owner and the tables they host. Storage and deletion per ADR-021/ADR-017. Universal-VTT-style import with wall data is a possible fast path **[unverified]**.

**Alternatives.** LLM-generated maps (invalid geometry, injectable). Upload-only (no content at launch). Pure image maps with no walls (LOS/cover impossible).

**Consequences.** MVP content effort: about 8 authored maps for 3 adventures. Procedural and upload are first cut candidates if the timeline slips (see architecture §11).

**Needs human?** Confirm upload is out of MVP; copyright/takedown and upload moderation are deferred legal items (architecture §17).
