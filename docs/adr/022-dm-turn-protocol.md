# ADR-022: DM turn protocol — tool set, schemas, prompt layout, recorded-LLM format

Status: Proposed (default) · Date: 2026-10-08 · Implements architecture §2–§4, §16 for M2 · Refines ADR-004, ADR-006, ADR-012, ADR-013

**Context.** ADR-004 fixes the boundary (engine owns state, LLM proposes typed calls) and lists a tool set at the level of names and purposes. Architecture §4 gives a prompt block order with token targets. Neither is implementable without guessing: no JSON schemas, no error codes, no fixture format, no statement of what happens on the second retry. M2-09..M2-12 (schema, then three tool-executor tickets) and M2-20 (prompt builder) all depend on those details, and M2 is solo-only (no party quorum, no moderation — see `docs/plan/m2-overview.md`). Spec drivers: §7.1, R-R2, R-M1, R-N1..N5, §9.1.

This ADR is the contract those tickets implement. Where it narrows architecture.md, §9 of this ADR names the edit.

---

## 1. Turn shape

A DM turn is a pure function of `(state, inputs, settings, turnSeed, llmTranscript)`. The orchestrator is the only component that talks to the LLM; the engine never does.

```
TurnStarted{turnId, seed, inputs[]}
  → (0..N) tool call / tool result pairs, each emitting engine events
  → exactly one narration
  → TurnCommitted{turnId, eventSeqRange, usage}
```

Invariants, each one testable:

| # | Invariant | Enforced by |
| --- | --- | --- |
| T1 | **One narration per turn.** The model may emit prose interleaved with tool calls; only the text of the final assistant message (the one carrying no tool calls) is narration. Earlier prose is discarded, not streamed. | Orchestrator discards text deltas while `pendingToolCalls > 0`. |
| T2 | **Roll events precede narration.** Every `RollEvent`/`HpChanged`/`EntityMoved` from a tool call is appended to the log and pushed to clients at the moment the tool returns — before the narration stream opens. | Ordering is structural: tool results exist only before the final message. |
| T3 | **Max 8 tool calls per turn** (`MAX_TOOL_CALLS`). Call 9 is refused with `turn-budget-exhausted` and the turn goes to fallback narration. | Orchestrator counter. |
| T4 | **Max 2 retries per rejected call** (R-R2), counted per *call site*, not per turn. | See §4. |
| T5 | **No state outside tool calls.** Narration text never mutates state; the snapshot is written from engine events only. | Engine `apply()` is the only writer (ADR-002 single writer). |
| T6 | **Narration is 60–180 words** (R-N1), hard-capped at 300. Over-cap turns are truncated at a sentence boundary and flagged `NarrationTruncated`. | Orchestrator post-check. |

Streaming: `maxTokens` for narration is 400 (≈300 words). Tool-call requests use `maxTokens` 512 and are not streamed to clients.

---

## 2. The M2 tool set

Architecture §3.2 lists 20 tools. M2 ships **16**. Deferred (not in the M2 schema at all, so an attempt to call one fails closed as `unknown-tool`):

| Deferred tool | Why | Lands |
| --- | --- | --- |
| `generate_encounter_map` | procedural maps are M5 | M5 |
| `call_for_rest` | opens a party vote; solo has no quorum | M4 |
| `ask_players` | spotlight tracker is a party mechanic | M4 |
| `contested_check` | adventure #1 has no opposed-roll beat; engine primitive exists, tool surface not needed | M4 |

`rest` in solo is a structured client command (`POST /session/:id/rest`), not an LLM tool — the model has no legitimate reason to decide when the player sleeps.

### 2.1 Common envelope

Every tool returns one of:

```json
{ "ok": true, "events": ["<EventType>…"], "summary": "Ayla rolls Stealth 17 vs DC 15: success." }
```

```json
{ "ok": false, "error": "out-of-range", "hint": "ent_gob2 is 35 ft away; longsword reach is 5 ft. Use move_to first or pick an adjacent target." }
```

`summary` is what the model sees as the tool result — one sentence, past tense, no dice formulas beyond the total, ≤ 200 chars. `events` is the list of event *types* emitted, for the model's awareness; payloads stay server-side (they are already streamed to the client). `hint` is always actionable and names the legal alternative; it is written for a model, not a human, and is never shown to players.

### 2.2 Entity-reference scheme

Four and only four reference kinds, each with a distinct prefix so a malformed reference is rejected lexically before any lookup:

| Kind | Prefix | Example | Scope | Issued by |
| --- | --- | --- | --- | --- |
| Catalog ID | `srd:` | `srd:spell/fireball`, `srd:monster/goblin`, `srd:item/rope-hempen` | global, versioned by `catalogVersion` | content catalog (ADR-008) |
| Session entity ID | `ent_` | `ent_ayla`, `ent_gob2` | one session | engine on placement |
| Map feature / marker | `feat_` / `mk_` | `feat_pillar1`, `mk_altar` | one map | map author / engine |
| Engine-issued option | `opt_` | `opt_7f3a` | one tool result, one turn | engine, see `suggest_area_target` |

Rules: `opt_` IDs expire at turn end and are single-use (`option-expired`). Registry IDs for NPCs/locations/quests use `npc_`, `loc_`, `quest_`, `flag_`, `ruling_`. Any reference not matching `^(srd:[a-z]+\/[a-z0-9-]+|(ent|feat|mk|opt|npc|loc|quest|flag|ruling)_[a-z0-9_-]{1,32})$` is `malformed-ref` without a database hit. **No tool accepts `x`/`y`/`distance`/`feet`** (ADR-018); schemas have `additionalProperties: false`, so a coordinate smuggled into an extra key is a schema violation.

### 2.3 Tool list with JSON schemas

Written as JSON Schema draft 2020-12 fragments; M2-09 expresses them as zod and derives both the JSON Schema (for `native` / `json-schema` modes) and the runtime validator from the same source. `additionalProperties: false` on every object; all listed properties required unless marked optional.

Shared definitions:

```json
{
  "$defs": {
    "entityRef": { "type": "string", "pattern": "^ent_[a-z0-9_-]{1,32}$" },
    "targetRef": { "type": "string", "pattern": "^(ent|feat|mk)_[a-z0-9_-]{1,32}$" },
    "ability": { "enum": ["str", "dex", "con", "int", "wis", "cha"] },
    "advantage": { "enum": ["normal", "advantage", "disadvantage"] },
    "dc": { "type": "integer", "minimum": 1, "maximum": 30 }
  }
}
```

**1. `request_check`** — ability or skill check.

```json
{
  "actorId": { "$ref": "#/$defs/entityRef" },
  "ability": { "$ref": "#/$defs/ability" },
  "skill": { "type": "string", "pattern": "^srd:skill/[a-z-]+$" },
  "dc": { "$ref": "#/$defs/dc" },
  "dcReason": { "type": "string", "minLength": 8, "maxLength": 120 },
  "advantage": { "$ref": "#/$defs/advantage" }
}
```

`skill` and `advantage` optional. `dcReason` is stored on the `RollEvent` and surfaced by "why DC 15?" (US-E2); it is mandatory so the model cannot set a DC silently. Result: `ok` with `RollEvent`; `summary` carries total, DC and pass/fail. Errors: `unknown-entity`, `not-in-scene`, `unknown-skill`, `dc-out-of-range`, `incapacitated-actor`.

**2. `request_save`**

```json
{
  "actorId": { "$ref": "#/$defs/entityRef" },
  "ability": { "$ref": "#/$defs/ability" },
  "dc": { "$ref": "#/$defs/dc" },
  "source": { "type": "string", "minLength": 3, "maxLength": 80 }
}
```

Errors: `unknown-entity`, `not-in-scene`, `dc-out-of-range`.

**3. `attack`**

```json
{
  "attackerId": { "$ref": "#/$defs/entityRef" },
  "targetId": { "$ref": "#/$defs/entityRef" },
  "attackId": { "type": "string", "pattern": "^srd:(weapon|attack)/[a-z0-9-]+$" }
}
```

The engine computes reach/range, line of sight, cover, advantage, the roll, crit, and damage from map state. No damage or modifier field exists. `RollEvent`, `HpChanged`, possibly `ConditionApplied`, `EntityDowned`. Errors: `unknown-entity`, `unknown-attack`, `not-equipped`, `out-of-range`, `no-line-of-sight`, `target-already-down`, `not-actors-turn`.

**4. `cast_spell`**

```json
{
  "casterId": { "$ref": "#/$defs/entityRef" },
  "spellId": { "type": "string", "pattern": "^srd:spell/[a-z0-9-]+$" },
  "slotLevel": { "type": "integer", "minimum": 0, "maximum": 9 },
  "target": {
    "oneOf": [
      { "properties": { "kind": { "const": "entity" }, "ref": { "$ref": "#/$defs/entityRef" } } },
      { "properties": { "kind": { "const": "anchor" }, "ref": { "$ref": "#/$defs/targetRef" } } },
      { "properties": { "kind": { "const": "option" }, "ref": { "type": "string", "pattern": "^opt_[a-z0-9]{4,8}$" } } },
      { "properties": { "kind": { "const": "self" } } }
    ]
  }
}
```

`slotLevel: 0` means cantrip. Area spells **must** use `anchor` or `option`. Errors: `unknown-spell`, `not-known`, `not-prepared`, `no-slot-available`, `slot-level-too-low`, `concentration-conflict`, `area-needs-anchor`, `option-expired`, `out-of-range`, `no-line-of-sight`.

**5/6. `apply_condition` / `remove_condition`**

```json
{
  "targetId": { "$ref": "#/$defs/entityRef" },
  "conditionId": { "type": "string", "pattern": "^srd:condition/[a-z-]+$" },
  "source": { "type": "string", "minLength": 3, "maxLength": 80 },
  "duration": { "enum": ["until-save", "end-of-next-turn", "1-minute", "1-hour", "until-removed"] }
}
```

SRD conditions only (closed enum from the catalog). The engine refuses `apply_condition` for conditions that the SRD only produces mechanically (`unconscious` at 0 HP, `dead`): `condition-engine-owned`. Narrative conditions (`frightened`, `prone`, `grappled`, …) are allowed. Errors also: `unknown-condition`, `already-applied`, `immune`.

**7. `start_combat`**

```json
{
  "enemies": {
    "type": "array", "minItems": 1, "maxItems": 12,
    "items": {
      "monsterId": { "type": "string", "pattern": "^srd:monster/[a-z0-9-]+$" },
      "count": { "type": "integer", "minimum": 1, "maximum": 8 },
      "spawnRef": { "$ref": "#/$defs/targetRef" }
    }
  },
  "ambushSide": { "enum": ["party", "enemies", "none"] }
}
```

`spawnRef` and `ambushSide` optional; without `spawnRef` the engine uses the map's spawn zones. Engine rolls initiative and emits `CombatStarted`, `MapLoaded`, `EntityPlaced`×n, `InitiativeRolled`. Encounter budget vs party level **warns in `summary`, never blocks** (architecture §3.2). Errors: `unknown-monster`, `already-in-combat`, `no-spawn-space`, `enemy-cap-exceeded`.

**8. `end_combat`** — `{ "outcome": { "enum": ["party-victory", "party-fled", "enemies-fled", "truce", "party-defeated"] } }`. Engine computes XP from CR. Errors: `not-in-combat`, `enemies-still-active` (hint names the live entity IDs).

**9. `move_to`**

```json
{
  "entityId": { "$ref": "#/$defs/entityRef" },
  "targetRef": { "$ref": "#/$defs/targetRef" },
  "mode": { "enum": ["adjacent", "within", "retreat", "cover"] }
}
```

Engine paths, charges movement, triggers opportunity attacks. `EntityMoved{path, cost}`, possibly `OpportunityTriggered`. Errors: `unknown-entity`, `unreachable`, `insufficient-movement` (hint gives remaining feet and the best reachable alternative), `not-actors-turn`, `restrained`.

**10. `suggest_area_target`**

```json
{
  "spellId": { "type": "string", "pattern": "^srd:spell/[a-z0-9-]+$" },
  "casterId": { "$ref": "#/$defs/entityRef" },
  "intent": { "enum": ["max-enemies", "avoid-allies", "cover-retreat", "hit-target"] },
  "focusRef": { "$ref": "#/$defs/targetRef" }
}
```

`focusRef` optional (required for `hit-target`). Returns up to 4 options and emits no events:

```json
{
  "ok": true,
  "events": [],
  "options": [
    { "optionId": "opt_7f3a", "label": "centred 15 ft NE of you: 3 goblins, no allies" },
    { "optionId": "opt_b210", "label": "centred on the pillar: 2 goblins, 1 ally (Brom)" }
  ],
  "summary": "2 placements offered."
}
```

The only read-only tool besides `rules_lookup`. Does not count against `MAX_TOOL_CALLS` (it cannot change state and refusing it would push weak models toward guessing).

**11/12. `grant_item` / `consume_item`**

```json
{
  "targetId": { "$ref": "#/$defs/entityRef" },
  "itemId": { "type": "string", "pattern": "^srd:(item|currency)/[a-z0-9-]+$" },
  "qty": { "type": "integer", "minimum": 1, "maximum": 999 }
}
```

Gold is `srd:currency/gp` and is bounded by the loot table for the encounter's CR: over-budget grants return `loot-budget-exceeded` with the allowed maximum in the hint. This is the structural answer to "give me 1000 gold". Errors also: `unknown-item`, `not-in-inventory`, `insufficient-qty`.

**13. `update_quest`** — `{ "questId": "quest_…", "status": {"enum":["available","active","completed","failed"]}, "note": {"type":"string","maxLength":240} }`. Errors: `unknown-quest`, `illegal-transition` (completed/failed are terminal).

**14/15/16. `upsert_npc` / `upsert_location` / `set_flag`**

```json
{
  "id": { "type": "string", "pattern": "^npc_[a-z0-9_-]{1,32}$" },
  "name": { "type": "string", "minLength": 2, "maxLength": 60 },
  "role": { "type": "string", "maxLength": 60 },
  "disposition": { "enum": ["hostile", "unfriendly", "neutral", "friendly", "ally"] },
  "facts": { "type": "array", "maxItems": 8, "items": { "type": "string", "maxLength": 160 } }
}
```

Facts **append only**; an upsert that would change an existing fact string returns `fact-immutable` and the hint tells the model to add a superseding fact instead (architecture §4 write path, R-M3). `upsert_location` is the same shape with `loc_` and no `disposition`. `set_flag` is `{ "flagId": "flag_…", "value": { "type": ["boolean","string","integer"] } }` with a 64-char string cap.

**17. `rules_lookup`** — `{ "topic": { "type": "string", "minLength": 3, "maxLength": 80 } }`. Returns up to 3 SRD chunks (≤ 400 tokens total) with citations (R-R3). Read-only, not counted in `MAX_TOOL_CALLS`, **max 2 per turn** (`lookup-budget-exhausted`) because it is the easiest way for a model to burn the latency budget.

**18. `log_ruling`** — `{ "topic": {"maxLength":80}, "ruling": {"maxLength":400} }` → `ruling_*` in the registry, retrieved in later turns (R-R4).

Counting: 16 state-changing tools (1–9, 11–16, 18) plus 2 read-only (10, 17).

### 2.4 Error code catalogue

Closed enum in `packages/schema/src/dm-tools.ts`. Codes are grouped by what the orchestrator does with them:

| Class | Codes | Orchestrator behaviour |
| --- | --- | --- |
| **Schema** | `malformed-ref`, `schema-violation`, `unknown-tool`, `missing-argument` | Retry with the validator message as hint. Never reaches the engine. |
| **Unknown reference** | `unknown-entity`, `unknown-spell`, `unknown-monster`, `unknown-item`, `unknown-skill`, `unknown-condition`, `unknown-quest`, `option-expired` | Retry; hint lists the up-to-10 legal IDs in scope. |
| **Legality** | `out-of-range`, `no-line-of-sight`, `unreachable`, `insufficient-movement`, `no-slot-available`, `slot-level-too-low`, `not-known`, `not-prepared`, `concentration-conflict`, `not-equipped`, `not-actors-turn`, `incapacitated-actor`, `restrained`, `immune`, `already-applied`, `target-already-down`, `not-in-combat`, `already-in-combat`, `enemies-still-active`, `no-spawn-space`, `area-needs-anchor`, `illegal-transition`, `not-in-inventory`, `insufficient-qty` | Retry; hint names the legal alternative. |
| **Policy** | `condition-engine-owned`, `loot-budget-exceeded`, `enemy-cap-exceeded`, `fact-immutable`, `dc-out-of-range` | Retry **once** only; a model that argues with policy twice is not going to win. |
| **Budget** | `turn-budget-exhausted`, `lookup-budget-exhausted` | No retry. Straight to fallback narration. |
| **Infrastructure** | `endpoint-timeout`, `endpoint-error`, `stream-aborted` | Not a tool error. See §4.2. |

The engine never returns an un-enumerated code; `packages/engine/test/tools-*.test.ts` asserts that every rejection path returns a member of the enum, and the schema test asserts that every enum member is produced by at least one test (no dead codes).

---

## 3. Who owns what

| Owner | Holds |
| --- | --- |
| **Engine** (`packages/engine`, pure) | All numbers: HP, slots, conditions, positions, initiative, order, XP, gold, dice. Legality. The registry's committed contents. `Battlemap`. |
| **Orchestrator** (`apps/server/src/dm`) | Turn lifecycle, seed draw, retry counters, prompt assembly, the LLM transcript for the turn, narration post-checks, fallback text, usage accounting. Holds nothing durable: on crash the turn is discarded, not resumed (US-R2 accepts loss of the in-flight turn). |
| **Model** | Nothing. It holds intent and prose for the duration of one turn's transcript. Its only persistent traces are narration text, registry facts written via tools, and `log_ruling` entries — all of which pass through a validated tool or are plain text. |

The model is not given: dice, seeds, coordinates, raw HP arithmetic, other sessions' data, the event log, or any write path that accepts a player-supplied quantity other than `qty` (bounded) and `dc` (bounded, reasoned).

---

## 4. Failure, retry, fallback

### 4.1 Tool-level (R-R2)

Retries are counted **per call site** — `attemptsFor[toolName + argHash]` — not per turn, so a model that fixes one bad `attack` and then makes a different bad `move_to` is not punished for the first. Cap 2 retries per call site, and a global cap of 5 retries per turn so a model cycling through fresh-but-wrong calls still terminates.

On exhaustion the orchestrator does **not** ask again. It injects a terminal tool result:

```json
{ "ok": false, "error": "out-of-range", "hint": "This action is not possible. Narrate the attempt failing and do not call this tool again.", "terminal": true }
```

and continues the turn. The model still writes one narration. State is unchanged. A `ToolCallRejected{turnId, toolName, error, attempt}` event is logged for each rejection (eval input for M2-38).

### 4.2 Turn-level

If the model produces no narration, or the endpoint fails (`endpoint-timeout` at 30 s, `endpoint-error`, `stream-aborted`), the orchestrator emits engine-written fallback narration and commits the turn with whatever events the successful tool calls already produced. The fallback is **template text, not LLM text**, so it is available when the endpoint is down:

| Case | Text |
| --- | --- |
| Rolls happened, no narration | "The dice have spoken — the results stand above. The scene holds for a moment. What do you do?" |
| No rolls, no narration | "Nothing comes of the attempt. What do you do?" |
| Endpoint unavailable | "The tale pauses — the storyteller has lost the thread. Your action was not resolved; try again." (no events committed) |

Each ends with a prompt for the next actor, so R-N2 holds even in failure. `TurnFallback{turnId, reason}` is logged and shown to the host as a neutral notice (ADR-013 §5 circuit breaker reads the same counter).

Timeouts: 30 s wall clock per turn, 12 s per LLM request, 500 ms per engine `apply()` (§9.1). Exceeding the engine budget is a bug, not a condition: it throws and the turn falls back.

### 4.3 What is *not* retried

Moderation does not exist in M2 (M3). Narration over 300 words is truncated, not re-prompted — a second generation doubles the latency budget to fix a cosmetic miss. Puppeting (R-N3) and map contradiction (R-N5) are **measured by the eval harness, not blocked at runtime** in M2; a runtime check would need a classifier call per turn and the thresholds are still unvalidated (see open point H3).

---

## 5. Prompt layout

Four blocks, in this order. The first two form the **byte-stable prefix**: given the same `(catalogVersion, toolMode, sceneId, settingsHash)`, blocks 1–2 are byte-identical across turns and across sessions in block 1's case. That is what makes provider prompt caching usable (ADR-009) and what makes recorded fixtures match on a hash rather than on fuzzy similarity.

| # | Block | Changes when | Budget (tokens) | Cacheable |
| --- | --- | --- | --- | --- |
| 1 | **Static prefix** — DM persona and style rules (R-N1..N3 as instructions), safety floor, tool schemas for the active tool mode, core rules cheat-sheet | `catalogVersion` or `toolMode` | 4,000 target / 5,500 hard cap | yes, cross-session |
| 2 | **Session-stable** — content tier and safety settings, party roster summary, adventure premise, current scene summary | scene boundary or settings change | 800 | yes, per session+scene |
| 3 | **Dynamic** — state projection (active PCs with HP/conditions/slots; in combat the order and engine `describe()` map text ≈ 350), registry facts for entities named in scope, last 6 turns verbatim, this round's inputs | every turn | 3,000 | no |
| 4 | **Retrieved memory** — top-k scene summaries and registry entries matching the inputs | every turn | 600 | no |

On resume, M2-27 assembles a “Previously on” recap from durable scene summaries and current registry facts; raw event/transcript rows are not required. The recap is bounded to 150 words and may be cached in the latest snapshot keyed by a stable hash of those inputs. Its text is quoted into the M2-20 retrieved-memory block, where it remains data rather than instructions. If the summary/recap endpoint is unavailable, the engine builds a deterministic recap from stored summaries, registry facts, and the latest available events without changing game state. Scene-summary calls are metered with purpose `summary` and use the configured guarded adapter.

Total prompt target ≤ 8,400 tokens, hard cap 10,000. Over-cap is resolved by trimming in a fixed order, so the result is deterministic: (a) transcript 6 → 4 → 2 turns; (b) retrieved memory 600 → 300 → 0; (c) registry facts to the 5 most recently mentioned entities; (d) `describe()` to the terse verbosity level. If still over cap, the turn proceeds and logs `PromptOverBudget{turnId, tokens}` — truncating the state projection is never acceptable, since a model reasoning from a partial map is worse than a slow turn.

**Byte-stability rules** (M2-20 must satisfy all four, asserted by `prompt.test.ts`):

1. Blocks are concatenated with a single `\n\n` and no trailing whitespace.
2. Every object serialized into a block uses sorted keys. No `Date.now()`, no `Math.random()`, no locale-dependent formatting anywhere in blocks 1–2. Timestamps appear only as in-fiction time (`World.time`), never as wall clock.
3. Tool schemas are emitted in the declaration order of `DM_TOOLS`, not alphabetically re-sorted per call, and not re-derived from a `Map` iteration.
4. `promptPrefixHash = sha256(block1 + block2)` is recorded in `TurnStarted`. A prefix hash changing without a `catalogVersion`/`toolMode`/`sceneId`/`settingsHash` change is a test failure.

Block 1 also carries the three narration rules the model must obey, phrased as constraints (word range, end on a hook, never narrate a PC's thoughts or unprompted actions, never state a distance or position not present in the state projection). They are in the cacheable block deliberately — they do not vary by table.

---

## 6. Determinism and the recorded-LLM format

### 6.1 Seed derivation

`turnSeed` is drawn per turn from the OS CSPRNG (ADR-004 §3.3) and logged in `TurnStarted`. Within the turn, each roll gets its own substream so that adding a roll earlier in the turn does not shift later rolls:

```
rollSeed(turnSeed, rollIndex) = xoshiro256ss(turnSeed ^ splitmix64(rollIndex))
```

`rollIndex` increments per `RollEvent` in engine command order, starting at 0. The engine receives `rng` already seeded; it never reads a clock or a global PRNG. Replaying the event log with the recorded `turnSeed` reproduces every roll exactly.

Rewind (ADR-003/§5) restores state and the retry draws a **new** seed — unchanged here, still flagged as human decision D5.

### 6.2 Recorded fixture format

One file per turn, newline-delimited JSON, under `fixtures/llm/<suite>/<nnn>-<slug>.ndjson`. NDJSON rather than one JSON object per scenario so a long turn diffs line by line in review, and so the replayer can stream.

Line 1 is a header; every following line is one interaction.

```ndjson
{"v":1,"kind":"header","suite":"adventure-1","turn":"t_0007","toolMode":"native","model":"recorded","catalogVersion":"srd-5.2.1-r3","promptPrefixHash":"sha256:9c1f…","turnSeed":"0x4f2a91c7b3e05d18","recordedAt":"2026-10-08","endpointProfile":"reference-hosted"}
{"kind":"request","i":0,"promptHash":"sha256:1a7b…","dynamicHash":"sha256:c40e…","toolNames":["request_check","attack","move_to","…"]}
{"kind":"response","i":0,"toolCalls":[{"id":"tc_1","name":"request_check","args":{"actorId":"ent_ayla","ability":"dex","skill":"srd:skill/stealth","dc":15,"dcReason":"loose gravel in the dark corridor"}}],"usage":{"in":8102,"out":74}}
{"kind":"toolResult","i":0,"callId":"tc_1","result":{"ok":true,"events":["RollEvent"],"summary":"Ayla rolls Stealth 17 vs DC 15: success."}}
{"kind":"request","i":1,"promptHash":"sha256:1a7b…","dynamicHash":"sha256:c40e…"}
{"kind":"response","i":1,"text":"You press into the shadow of the broken arch…","usage":{"in":8190,"out":128}}
```

Field notes:

- `promptHash` covers blocks 1–4 of that request; `dynamicHash` covers blocks 3–4 alone. Two hashes because a block-1 edit (a reworded persona) should not invalidate every fixture, while a state-projection change must.
- `toolResult` lines are recorded but **not replayed**: on replay the engine recomputes them with the same seed, and the replayer asserts the recomputed result equals the recorded one. That is the determinism test. A mismatch fails with a diff — this is how an engine regression is caught by a fixture rather than hidden by it.
- `usage` is kept so the cost meter has real numbers in recorded mode (M2-39 timings).

### 6.3 Replay semantics

```
RecordedAdapter.complete(request):
  i = nextIndex()
  expect fixture[i].kind == "request"
  if fixture[i].dynamicHash != sha256(blocks 3..4):
      if LLM_FIXTURE_MODE == "strict": fail "fixture drift at i=<i>"
      else: warn and continue
  return fixture[i+1] as a stream (text deltas chunked at 24 chars to exercise streaming)
```

Three modes via `LLM_FIXTURE_MODE`: `strict` (CI default — any hash drift fails), `lenient` (local development — warns), `record` (calls the real endpoint and writes the fixture; never runs in CI). Prefix-hash drift is always a failure, in every mode, because it means prompt caching broke.

Fixtures are committed. Re-recording is a reviewable diff and the PR must say what changed in the prompt. `apps/server/test/dm/replay.test.ts` runs every fixture in the suite in `strict` mode.

### 6.4 Worked example: one combat turn, end to end

Setup: adventure #1, round 2 of combat on `map_waystation_crypt`. `ent_ayla` (rogue, PC) is active. Two goblins: `ent_gob1` adjacent, `ent_gob2` 35 ft away behind `feat_pillar1`. Player input: *"I stab the one next to me, then duck behind the pillar."* Turn seed `0x4f2a91c7b3e05d18`.

| Step | Actor | Content |
| --- | --- | --- |
| 1 | Room | `TurnStarted{turnId:"t_0012", seed:"0x4f2a…", promptPrefixHash:"sha256:9c1f…"}` |
| 2 | Orchestrator | Builds prompt: block 1 (4,012 tok, cache hit), block 2 (periodic 740), block 3 (2,480 incl. `describe()` 352), block 4 (310). Total 7,542. |
| 3 | Model | `attack{attackerId:"ent_ayla", targetId:"ent_gob2", attackId:"srd:weapon/dagger"}` — wrong goblin. |
| 4 | Engine | `{ok:false, error:"out-of-range", hint:"ent_gob2 is 35 ft away; dagger reach is 5 ft. Adjacent enemies: ent_gob1."}` → `ToolCallRejected{attempt:1}` |
| 5 | Model | `attack{attackerId:"ent_ayla", targetId:"ent_gob1", attackId:"srd:weapon/dagger"}` |
| 6 | Engine | roll 0: d20 → 18 (+5) hit; roll 1: 1d4+3 → 6. `RollEvent`×2, `HpChanged{ent_gob1, 7→1}`. `summary:"Ayla hits ent_gob1 with a dagger for 6; it is bloodied."` Streamed to client **now** (T2). |
| 7 | Model | `move_to{entityId:"ent_ayla", targetRef:"feat_pillar1", mode:"cover"}` |
| 8 | Engine | Path 15 ft, leaves `ent_gob1`'s reach → `OpportunityTriggered`. Reaction window is engine-side and auto-resolves for a monster: roll 2 → miss. `EntityMoved{path, cost:15}`, `RollEvent`. |
| 9 | Model | Narration, 132 words, ends "…the goblin snarls and circles. What do you do?" — streamed to the client. |
| 10 | Orchestrator | Word count 132 ∈ [60,180] ✓. `TurnCommitted{turnId:"t_0012", seq:[214,221], usage:{in:15084, out:286}}`, snapshot written in the same transaction. |

The fixture for this turn is 7 lines (header, 3 request/response pairs is 6 plus 3 `toolResult` lines = 10 lines). Replay with the same seed must reproduce 18, 6, and the missed opportunity attack; if the engine's advantage logic changes, step 6's recomputed `summary` diverges and `replay.test.ts` fails.

---

## 7. New event types

Added to the architecture §15.6 list by this ADR:

| Event | Payload | Why |
| --- | --- | --- |
| `ToolCallRejected` | `{turnId, toolName, error, attempt, argHash}` | R-R2 evidence and eval input; previously unlogged. |
| `TurnFallback` | `{turnId, reason: "no-narration" \| "endpoint-error" \| "budget-exhausted"}` | Drives the circuit breaker and the host notice. |
| `NarrationTruncated` | `{turnId, words}` | R-N1 measurement. |
| `PromptOverBudget` | `{turnId, tokens, trimsApplied[]}` | Catches projection growth before it costs money. |
| `EntityDowned` | `{entityId, by}` | Already implied by `HpChanged` reaching 0, but narration and combat-end checks both need it explicitly. |

`TurnStarted` gains `promptPrefixHash` and `inputs[]`. `TurnCommitted` gains `usage{in,out,cacheRead?}`.

---

## 8. Alternatives rejected

| Option | Why rejected |
| --- | --- |
| **Model emits one JSON plan per turn (all tool calls up front), engine executes the batch.** Tempting: one round trip, lowest latency, trivially recordable. | Rejected. Tool results feed the next decision: you cannot pick a target before you know whether the stealth check passed, and combat positioning is sequential. A batch plan either forces the model to guess outcomes or forces conditional logic into the plan format, which is a worse language than a tool loop. Kept as the shape of `engine-assist` (M5), where the model's job is reduced to picking from `legalOptions`. |
| **Allow narration interleaved with tool calls, streamed as it arrives.** Better perceived latency. | Rejected. The model would narrate an outcome before the engine rolled it, which is exactly the authority inversion ADR-004 exists to prevent, and R-N5 contradictions become unavoidable. T1 instead. Perceived latency is addressed by streaming roll events immediately (T2), which arrive earlier than any prose would. |
| **Retry counted per turn rather than per call site.** Simpler counter. | Rejected. A model that recovers from one mistake would be cut off for an unrelated later one, producing fallback narration in turns that were going fine. Per-call-site with a global cap of 5 bounds the worst case at the same place. |
| **Re-prompt on narration policy misses (length, puppeting).** Higher quality per turn. | Rejected for M2. Doubles the latency budget to fix cosmetic issues, and the classifier thresholds are unvalidated. Measure in eval first (H3). |
| **Fixture format: one JSON file per scenario, matched by prompt similarity.** Tolerant of prompt edits. | Rejected. Similarity matching hides prompt regressions, which is the main thing the fixtures should catch. Hash-based with explicit `record` mode makes a prompt change a visible diff. |
| **Record tool results and replay them instead of recomputing.** Faster tests, no engine coupling. | Rejected. Replaying recorded engine output means the fixtures pass even when the engine breaks. Recompute-and-assert turns every fixture into an engine regression test for free. |
| **Free-text entity names with fuzzy resolution.** Far easier for weak models. | Rejected per ADR-004. Fuzzy name matching is how a model attacks the wrong goblin and the engine lets it. The `unknown-entity` hint listing legal IDs gives weak models a cheap recovery path instead. |
| **A `roll_dice` tool for edge cases.** | Rejected. ADR-004 already forbids it. Every unanchored roll is a path for the model to invent mechanics. |
| **Vector retrieval for block 4 in M2.** | Rejected per ADR-006: Postgres FTS + trigram first, `pgvector` only if recall evals fail. |

---

## 9. Changes this ADR requires in architecture.md

Named, not applied here (one doc edit per PR keeps review honest):

1. **§3.2 tool table:** mark `generate_encounter_map`, `call_for_rest`, `ask_players`, `contested_check` as post-M2; add `suggest_area_target` result shape; replace the free-text `attack(weaponOrAttackId)` wording with the `srd:` prefixed form.
2. **§3.2 prose:** "up to 2 retries" → "up to 2 retries per call site, global cap 5 per turn".
3. **§4 budgets:** block 3 target 3k → 3,000 with the named trim order; add the 10,000-token hard cap and the trim sequence.
4. **§15.6 events:** add the five new events in §7 above and the `TurnStarted`/`TurnCommitted` field additions.
5. **§2.3 sequence diagram:** add the `ToolCallRejected` path and the fallback branch; it currently shows only the happy path.

---

## 10. Consequences

Forge can implement M2-09 (schemas and events) directly from §2 and §7, M2-10..12 from §2.3 and §2.4 without inventing error codes, and M2-20 from §5 with four testable byte-stability assertions. Prism's fixture work (M2-21+) has a format and a replay contract. The cost is rigidity: adding a tool now means editing the enum, the schema, the error catalogue, and the static prefix — deliberate, since the tool set is the product's main evolution surface and silent additions are how the boundary erodes.

The 16-tool static prefix is estimated at 4,000 tokens **[unverified]** — nobody has serialized the schemas and counted. If it lands over 5,500, the fix is per-mode schema pruning (combat tools omitted outside combat), which breaks cross-session cache sharing; flagged as a measurement task for M2-20, not a decision.

---

## 11. Open points that need the human

Listed, not decided.

1. **H1 — Retry visibility.** Should a player see that the DM proposed something illegal (a "the DM reconsiders" beat), or is the retry invisible? Invisible is my default and is what §4.1 assumes; visible is more honest and may be more fun. Affects the client, not the protocol.
2. **H2 — Fallback narration wording.** The three templates in §4.2 are mine, and they are the only words a player sees when the model fails. Quill should write them; the human should approve the tone (they break immersion by design or they do not).
3. **H3 — Runtime vs eval-only enforcement of R-N3/R-N5.** M2 measures puppeting and map contradiction in eval and does not block them at runtime. If the human wants a runtime guard before live play (overview risk 1), it needs a classifier call per turn and a latency budget increase — a product call, not an architecture one.
4. **H4 — `dc` set by the model at all.** The model proposes DCs within 1–30 with a stated reason. An alternative is a closed enum (`easy|medium|hard|very-hard` → 10/15/20/25) which removes DC drift entirely at the cost of SRD fidelity. I default to the numeric form because the SRD uses numbers; the human may prefer the enum for consistency across tables.
5. **H5 — Fixture re-recording policy.** Who may re-record (`LLM_FIXTURE_MODE=record`) and against which endpoint? If fixtures are re-recorded against a different model than the reference endpoint, the eval baselines move silently. Related to Q1 in the M2 overview and unresolvable until the reference endpoint exists.
6. **H6 — Turn timeout of 30 s.** Chosen as roughly 4× the §9.1 8-second p95 target. On a slow local model it will fire routinely and every turn will fall back. Either the timeout is per endpoint profile (operator-set, my preference) or local models are declared out of scope for timing — needs Q1's answer first.
