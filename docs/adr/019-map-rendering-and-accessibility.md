# ADR-019: Map rendering behind a `MapRenderer` seam (2D canvas in MVP); DOM-based accessible alternative

Status: Proposed (default) · Date: 2026-10-06

**Context.** Combat shows a graphic map with minis and terrain. A canvas is opaque to assistive tech. WCAG 2.2 AA is an MVP requirement (spec §9.3). A 3D view is a later phase (ADR-021).

**Decision.**
- **Renderer seam:** `MapRenderer.render(mapView, entities, overlays)` plus `MapIntent` events (select, hover, commit move, aim area). MVP implementation is **2D top-down Canvas 2D** (map is at most 60x60 with fewer than 40 tokens; no WebGL needed). A WebGL/three.js renderer can later implement the same interface (ADR-021). Rendering reads server-sent state and engine overlays; it never decides legality.
- **Overlays** computed with the shared engine: reachable cells, threat range, path preview with cost, area template preview, LOS line, cover pips.
- **Tokens/terrain art:** original or properly licensed tile atlas; mini tokens are portrait or icon with team ring and a non-color team marker; footprints for larger sizes.
- **Accessible alternatives (required, not optional):**
  1. **Keyboard cursor:** the map is a single focusable region with a roving cell cursor (arrows), `Tab` cycles entities (nearest-first or initiative order), `Enter` selects, `M` enters move mode (arrows step with live cost readout, `Enter` commit, `Esc` cancel), hotkeys for "nearest enemy" and "my position". Pan/zoom by keyboard.
  2. **Text description:** `describe()` from the engine feeds a live region and a read-on-demand panel: positions as grid references and relative direction/distance, cover and terrain notes, threats. Verbosity levels. Announced per event, not per frame.
  3. **List-driven combat mode:** a toggle that hides the canvas and offers the engine's `legalOptions` as a list ("Move adjacent to Goblin A, 15 ft", "Retreat behind the pillar"), selected by `optionId`. Full combat is playable without the map.
  4. Reduced motion = instant moves; high-contrast and pattern-coded terrain/teams; 44 px targets; 360 px layouts degrade to the list-driven mode plus a pannable map.
- **Test:** axe-core on map chrome, Playwright keyboard-only combat script, manual screen-reader pass per release.

**Alternatives.** WebGL 2D library (heavier, not needed at this scale). 3D from the start (scope and a11y cost). Canvas only with no DOM alternative (fails WCAG).

**Consequences.** Prism owns two surfaces (canvas and list/keyboard) over one engine API. `describe()` doubles as compact LLM map context (about 300-400 tokens in combat).

**Needs human?** No.
