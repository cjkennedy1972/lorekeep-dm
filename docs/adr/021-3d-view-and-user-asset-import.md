# ADR-021: Later-phase 3D/isometric view with user-supplied GLB/STL minis and terrain: server-side ingest, moderation, storage

Status: Proposed, **later-phase sketch only** (not in any milestone; 2D top-down is the first release per human decision 2026-10-06; the sketch only keeps MVP seams from blocking it) · Date: 2026-10-06

**Context.** Users may later supply STL or GLB models for minis and terrain. Files are untrusted binary input, can be huge, are not scaled consistently, and can be inappropriate or infringing. The engine stays authoritative for mechanics.

**Decision.**
- **View:** a three.js-style renderer implements `MapRenderer` (ADR-019), isometric or orbit camera, instanced meshes, LOD, automatic fallback to 2D on weak devices or 360 px. Accessible alternatives (keyboard, text, list mode) are unchanged and mandatory.
- **Formats:** **GLB (glTF 2.0 binary)** is the canonical stored format. STL is accepted and converted to GLB at ingest (STL has no units, materials, or scale).
- **Ingest pipeline (server-side, sandboxed worker, never trust the browser to parse first):**
  1. Caps: 20 MB upload, 100k triangles per mini after decimation, 2048 px textures, reject external URIs and non-allowlisted glTF extensions; re-encode embedded images.
  2. Normalize: Y-up, pivot at base center, recenter, sanity-check bounding box, user picks size category and the model is fit to the footprint (Medium = 1 cell); STL units assumed millimetres with a confirmation prompt.
  3. Render a server-side turntable (4-6 views) as thumbnails.
  4. **Moderation:** image classifier on the renders plus hash blocklist before `approved`; status `pending -> approved | rejected | quarantined`; user report flow; mature-flagged assets only usable at mature tables (ADR-016).
- **Mechanics stay separate from visuals:** a terrain model never changes engine state. The owner assigns a footprint and a mechanical class (`blocks`, `half cover`, `difficult`, `decor`) from the same palette the engine already understands; the engine uses only that.
- **Storage:** object store, content-addressed `assets/{ownerId}/{sha256}.glb`, metadata in Postgres (`assets`: owner, sha256, kind, status, triangle count, bbox, scale meta, moderation refs, timestamps), signed short-lived URLs, per-account quota (default 200 MB, assumption). Retention and deletion per ADR-017 (rejected/quarantined 30 days; deleted with account).
- **Copyright:** uploader warrants rights; IP, upload moderation, and takedown policy are deferred legal items (architecture §17) to settle before this phase is built.

**Alternatives.** Client-only parsing (untrusted parser surface, no moderation). Hosted asset marketplace (explicit non-goal). Supporting every 3D format (FBX/OBJ later if asked).

**Consequences.** This phase adds an ingest worker, a moderation vendor or model, and storage cost; it has no milestone work and is not in the build plan.

**Needs human?** **Yes:** whether to build it at all; moderation vendor; copyright/takedown policy.
