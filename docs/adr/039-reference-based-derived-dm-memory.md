# ADR-039: Reference-based derived DM memory and no stored player quotes

Status: Proposed · Date: 2026-10-30 · Refines ADR-006, ADR-017, ADR-024 and ADR-025 · Workboard: fe153f81 (c691a4a5 unverified; Atlas checking board)

## Context

`scene_summaries` stores generated prose. `registry_entries` stores names, aliases, payload prose and materialized search text; `registry_facts` stores fact strings. Retrieval (`RegistryMemory.retrieve`/`contextFor`) and recap callers place these rows into downstream prompts. Current fallback scans arbitrary event payload keys (`summary`, `description`, `name`, `text`). Account deletion in #419 fences affected sessions and scrubs derived rows; substring replacement is unsafe and cannot identify quoted text reliably.

Canonical events distinguish player input from server-authored outcomes. In particular, `PlayerAction.text` is player-authored and excluded, as is `NarrationCompleted` (generated narration can contain player names or reproduce player wording). Existing generated rows lack reliable provenance and cannot be losslessly converted into references.

## Decision

### Input boundary and deterministic fallback

The summarizer receives only a server-built allowlisted projection. The initial event allowlist is explicit and versioned in code: `CharacterJoined` (character/seat ids and server-authored display identity needed only for matching), validated mechanics/outcome event types selected by implementation (type plus enumerated schema fields), and no free-form event payload pass-through. Every allowed event type has an enumerated field list and origin rationale; unknown event types and fields are dropped. `PlayerAction.text` (up to 4000 chars) and `NarrationCompleted` are explicitly excluded. The projection is the sole input to both the model and deterministic fallback; fallback formats only enumerated projected fields and never scans payload keys or copies arbitrary text. Any added type/field requires an explicit privacy review and allowlist change.

### References, mapping and write gate

Persist opaque character-reference tokens instead of player-character display names or aliases in every derived summary/registry field, including registry name, aliases, payload, facts, search document/vector source and any derived cache. Tokens are generated with a cryptographically secure RNG (at least 128 bits of entropy), are not derived from ids/names, and are stable per character per session—not per summary—so references link consistently across summaries and registry rows. A database mapping table `(session_id, character_id, token)` has unique constraints on both `(session_id, character_id)` and `(session_id, token)`; delete the mapping when that character is deleted from the session. For every projected event, validate each referenced seat against the authoritative seat-to-character binding at that event/turn, then require the character id to exist in the captured mapping; never infer a character from a display name. Reject inconsistent, missing, or ambiguous bindings rather than assigning a token. Seat rebinding never retargets an existing character id/token. A new character gets a new token.

At summarizer start, capture the current session lease/fence epoch and the session's authoritative character ids, display names, and aliases. Validate every generated reference token against that captured mapping and validate token syntax/length. Before any write, reject the entire summary/registry diff if it contains any captured player's display name or alias (case-insensitive normalized matching, including token boundary-safe matching), or any unknown/malformed token. Apply this gate to model output, deterministic fallback, and any summary/registry write path; do not rely on deletion-time string matching. Registry diffs remain schema validated. On rejection, use a non-identifying static fallback only if it independently passes the same checks; otherwise do not write.

### Read boundary and injection

Stored values are untrusted. Re-screen each retrieved summary and registry value against the current session's character names and aliases immediately before prompt insertion, in both `retrieve` and `contextFor` (including `mentionedFacts`/recap paths that can reach prompts). Drop a row/fact that fails screening; do not repair it with substitution. Resolve token references only after screening and authorization. Bound display names at the renderer (maximum 80 Unicode code points and 320 UTF-8 bytes; reject/neutral-label longer values), and escape them for the exact prompt/rendering context. Rendering is single-pass: parse the stored template once, substitute tokens from the captured mapping once, and never rescan or substitute inside inserted names. A character name containing a token-shaped string is emitted literally and cannot trigger a second replacement. Deleted/unavailable references render a neutral label.

### Transaction fencing, holds, deletion and legacy clear

`RegistryMemory.closeScene` writes through `this.pool`; its transaction must lock/check the session lease row and compare the fence epoch captured when summarization began before inserting the summary or registry diffs. A changed epoch, active deletion fence, or post-scrub state rejects the whole write (rollback); checking only at summarizer start is insufficient. Apply equivalent write fencing to other registry mutation entry points.

Legal holds are authoritative: derived rows for a held session are neither scrubbed nor rewritten. Deletion fails closed as in #419 when a relevant account/session/export hold is found; do not partially clear held-session derived data. The legacy clear must also skip held sessions, and must not bypass hold checks through a bulk migration.

Code inspection: `registry_entries` are written from validated registry events and scene-close diffs; no replay/rebuild path reconstructs them from canonical events. Therefore a one-time legacy clear loses registry continuity (and legacy summaries) and cannot promise reconstruction. Make the one-time clear an implementation gate requiring explicit owner (Chris) approval before execution. Until approved, rollout must not clear legacy rows or claim the invariant for pre-existing rows; new writes still enforce it. Clear only unheld sessions after approval, with idempotent counts-only audit. Do not attempt string replacement or heuristic classification.

### Export and rewind

`accounts/export.ts` currently exports solo-session summaries, but not registry entries or reference mappings. Keep summary export behavior, ensuring exported summaries are screened and rendered only for the exporting authorized character/session; never export token mappings or another player's names. Document this scope and apply the same deletion/hold lifecycle to any future export of derived rows.

Honor ADR-024/025 turn linkage: scene summaries and registry versions carry the producing `turn_id`; a rewind removes rows from reverted turns and restores surviving supersession links atomically with `TurnReverted`. Token mappings are character/session identity data, not turn-derived data, and are not removed by rewind. Rewind must not make a token available for a different character. Legacy NULL `turn_id` rows retain the ADR-024 limitation until the approved legacy clear; ADR-025 linkage does not weaken the new write gate.

### Options considered

| Option | Cost and trade-off |
|---|---|
| **A. Reference-bearing prose (chosen).** | Medium-high. Preserves cross-summary continuity while enforcing the write/read boundaries above; legacy clear entails explicit continuity loss and approval gate. |
| **B. Fully structured memory records.** | Higher redesign cost; stronger typed references, but changes all persistence, retrieval, recap, search and presentation callers. |
| Name-removal/string scrub | Rejected: ambiguous, corrupts common/co-player text and cannot reliably detect paraphrases or quotes. |

## Consequences

- Deletion operates on character ids/references and removes mapping rows and affected derived data transactionally; no name-based scrub. Search indexes are regenerated from screened reference-bearing fields.
- Rename changes rendering only. Seat rebinding does not retarget historical references. Deleted refs are neutralized, never rendered with former names.
- NPC/location names remain canonical; the guarantee is specific to player characters and player-authored text.
- Search may expand authorized query terms at read time, but never persist current player names. Reduced recall is acceptable over persisting names.
- Recap/cache consumers must use the same screening, authorization and single-pass rendering seam.
- Workboard card `c691a4a5` is unverified; Atlas is checking the board. The stored-injection requirement is included regardless.

## Implementation breakdown (proposed; sizes)

1. **Forge — L (8–13 days): projection, mapping and write gate.** Explicit event/field allowlist, token table and generation, stable character/session tokens, model schema validation, deterministic fallback projection, display-name/alias diff rejection, and epoch capture plumbing.
2. **Prism — L (8–13 days): transactional persistence and read/render seam.** Fence-checked closeScene and all registry writers; retrieval/contextFor/recap screening; authorized token resolution; bounded escaped names and single-pass renderer; search refresh and cache invalidation.
3. **Forge — M (5–8 days): deletion, holds, rewind/export and approved rollout.** Hold-aware fail-closed scrub and legacy clear; mapping lifecycle; ADR-024/025 turn linkage; solo export screening; counts-only clear job gated on explicit Chris approval and documented continuity loss.
4. **Prism — M (5–8 days): verification and regression review.** Cover forbidden event/text fields, name/alias rejection, malformed/unknown tokens, cross-summary linking, injection on retrieval, token-looking display names, stale fence/post-scrub writes, holds, rewind, export, deletion, and legacy-clear approval gate.

## Verification plan

- Projection tests assert only named allowlisted fields reach both model and deterministic fallback; `PlayerAction.text` and `NarrationCompleted` never do.
- Write tests reject a name/alias in any summary/registry field and reject malformed/unknown tokens; assert stable cross-summary token identity and per-event mapping correctness.
- Transaction tests race closeScene with #419 fencing and prove stale epochs/post-scrub writes roll back; held sessions are unchanged and deletion fails closed.
- Retrieval tests prove stored injection/name leakage is dropped before prompt insertion, rendering bounds/escapes names, and token-shaped names are not rescanned.
- Rewind tests prove turn-linked rows are removed atomically and mappings remain character-stable; export tests enforce solo authorized scope and omit mapping data.
- Legacy-clear tests establish hold-awareness, idempotence, and no registry rebuild claim. Execution remains blocked until explicit Chris approval.
