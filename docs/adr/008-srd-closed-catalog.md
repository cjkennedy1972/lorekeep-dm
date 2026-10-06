# ADR-008: SRD 5.2.1 closed catalog referenced by ID; original setting

Status: **Accepted** (human confirmed SRD 5.2.1, 2026-10-06) · Date: 2026-10-06

**Context.** CC-BY-4.0 SRD only (spec §8, research §1). LLMs readily emit non-SRD names. Trademark/attribution duties.

**Decision.**
- Target **SRD 5.2.1** (2024 rules; the spec's 12 classes with one subclass each matches it). Pin `catalogVersion` per session.
- Hand-reviewed, schema-validated JSON catalog (species, classes, backgrounds, equipment, spells ≤ L3, monsters CR ≤ 5, conditions, magic items), loaded by ID; out-of-scope IDs are unloadable.
- Tools only accept catalog IDs; output scan uses a non-SRD proper-noun denylist.
- Exact CC-BY attribution text in footer/credits; "5E compatible" phrasing only; no WotC marks in the product name; original setting and adventures.
- Legal review before public launch.

**Alternatives.** SRD 5.1 (older rules, 2014 content, still available); both at once (double the engine). Supporting 5.1 later means a second catalog and engine rule-set flag.

**Consequences.** Switching versions after M1 is expensive (engine rules differ).

**Needs human?** Version is confirmed. Legal review before public launch (Q1) is still open. Map rules (grid, cover, areas) must be checked against SRD 5.2.1 text during M1 **[unverified]**.
