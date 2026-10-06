# Reuse audit: `foundryvtt-ai-gm` -> Lorekeep-DM

Date: 2026-10-06 · Author: Scout (Researcher) · Inputs: `architecture.md` v0.1, `spec.md` v0.1, `adr/` (file names only; **ADR bodies not read**, ADR-004 is inferred from architecture §3 and the file name `004-rules-engine-llm-boundary.md`).
Source audited: https://github.com/cjkennedy1972/foundryvtt-ai-gm, shallow clone at `/tmp/fvtt-ai-gm` (HEAD only; 1 commit visible, 724 tracked files). Read-only; nothing pushed.
Paths below are relative to the repo root; `ai-engine/` is the Python backend.

## 0. Bottom line

The repo is a **Python/FastAPI "autonomous GM" that drives a live FoundryVTT instance through a REST relay**. Its value for the new project is **patterns and prompts, not code to lift**. The new architecture puts a deterministic, pure Rules Engine under a single-writer Room (ADR-004, ADR-002). The old repo has neither: **it has no rules engine in the architecture's sense**. Dice, attack resolution, HP, slots, and conditions are all computed *inside Foundry's dnd5e system* by JavaScript the engine injects (`foundry/scripts.py`, e.g. `resolve_item_attack` at line 56 "roll attack, check hit vs the target's AC, roll damage on a hit, apply it"). `rules/` is a 263-line reference lookup (`rules/engine.py`, `rules/database.py`), not an adjudicator. State of record is Foundry actor sheets (`actions/undo.py`, `referee/agent.py` docstrings say so explicitly).

Net: of ~125k lines of code, I'd estimate **under ~8k lines are plausibly portable** (schemas, audit/undo concepts, memory layers, eval harness, NPC chat, TTS voice assignment, ComfyUI prompts), and almost all of those are **Port or Redesign, not as-is**. Most of the repo (Foundry client/chat listener 5.3k, relay manager 1.1k, module integrations, immersion, scene placement, campaign deploy) is **Drop**. The language gap also matters: the repo is Python; ADR-001 picks TypeScript, so even "Reuse as-is" means *reuse the design and prompts*, with a re-implementation.

Sizes are `wc -l` over tracked, non-test files unless noted. Tests: 315 files under `ai-engine/tests`, ~3,966 `def test_` functions (grep count), which are mostly coupled to the Foundry mocks.

## 1. Classification summary

| # | Piece | Verdict | Language / size | Maps to (architecture) |
|---|---|---|---|---|
| 1 | ~47 schema-validated actions | **Port** (schemas + discipline) / **Redesign** (catalog) | Python, `actions/` 4,014 | `dm-orchestrator` tool contract (§3.2), `rules-engine` commands |
| 2 | Combat loop + timeouts | **Redesign** (keep timeout/fallback ideas) | Python, `combat/` 2,880 (`loop.py` 1,518) | `room` combat state, engine monster policy (§2.4) |
| 3 | Rules engine / 5e reference | **Drop** code; **Port** a few tables | Python, `rules/` 263; `combat/difficulty.py` 279 | `catalog`, `rules-engine` (new, M1) |
| 4 | Campaign builder | **Redesign** (concept) / **Drop** (deploy half) | Python, `campaign/` 16,818 | Adventure authoring data (§7), Phase 3 |
| 5 | Lore / vault memory | **Port** (campaign_memory design) / **Drop** (vault, embeddings) | Python, `context/` 1,851, `vault/` 721 | `memory` (§4), ADR-006 |
| 6 | NPC chat | **Port** | Python, `npc/` 895 | `memory` registry + `dm-orchestrator` (small side-channel) |
| 7 | Undo | **Redesign** | Python, `actions/undo.py` 157 | `persistence.rewind` (§5), ADR-003 |
| 8 | TTS narration | **Port** (voice assigner, sentence splitter) / **Redesign** (delivery) | Python, `tts/` 911 | Spec P1 TTS; output-gate chunking (§6) |
| 9 | ComfyUI map/portrait gen | **Port** (prompts) / **Drop** (map-to-Foundry plumbing) | Python, `campaign/map_generator.py` 1,214 | Spec Phase 2 "scene illustrations" |
| 10 | Event log / audit trail | **Port** (concept + reducers) | Python, `events/` 414, `actions/audit.py` 133, `persistence/` 918 | `persistence` (§5), ADR-003 |
| 11 | Admin panel | **Redesign** (UI), **Drop** (code) | React/Vite JS, `admin-panel/` 5,252 (non-test) | Operator console (spec P-Admin, P1) |
| 12 | LLM manager / router / usage | **Port** (budget + tiering idea) | Python, `llm/` 1,481 | `dm-orchestrator`, ADR-009 |
| 13 | Referee (DC/slot sanity) | **Drop** (superseded) | Python, 136 | Engine legality checks |
| 14 | Evals / replay harness | **Port** (design, scenarios) | Python, `evals/` 4,970 (30 scenario JSONs) | ADR-012, §10 |
| 15 | Foundry client, chat listener, scene, immersion, module adapters, relay | **Drop** | Python+Go submodule | n/a |

Everything not listed was not individually classified (see §6 "Not read").

## 2. Piece-by-piece

### 2.1 The ~47 schema-validated actions: **Port the schema discipline, Redesign the catalog**
- **Evidence:** `actions/schemas.py` (758 lines). `ACTION_SCHEMAS` dict has **47 entries** (confirmed by counting keys with a script). Every model uses `ConfigDict(extra="forbid")`; numeric bounds (`MIN_DAMAGE=-200`, `MAX_DAMAGE=500`, `ge/le` on DC 0-40, spell level 0-9). `actions/dispatcher.py` validates, rejects unknown fields, applies an allowlist (`PLAYER_ALLOWED_ACTIONS`), clamps damage, injects dependencies by `inspect.signature` (its own comment calls this "fragile", lines ~111-124), then executes and audits.
- **What transfers:** the *dispatch pipeline shape* (validate strictly -> reject unknown fields -> clamp -> execute -> uniform `{success, error}` result -> audit record in one place) matches architecture §3.2 and R-R2 well. Pydantic models translate roughly 1:1 to zod schemas. Prompt text in `llm/system_prompts.py` (678 lines, `ACTION_FORMAT_INSTRUCTIONS`) is a usable starting draft for the DM persona and tool-use rules (**read lines 1-40 only**).
- **What does not transfer (conflict, see §4):**
  - Roughly half the 47 are Foundry presentation or scene-building and have no meaning in a web game: `move_token`, `place_walls/lights/sounds/token`, `configure_scene`, `setup_scene`, `generate_map`, `play_sound/music`, `set_weather/time`, `apply_token_effect`, `update_vision`, `execute_js`, `execute_macro`, `pause_game/resume_game`, `whisper`, `prompt_player`, `switch_scene`.
  - The mechanical ones are **free-form and LLM-driven**: `update_hp(actor_uuid, damage)` lets the LLM pick any damage from -200 to +500 (`schemas.py` lines 81-98); `roll(formula, speaker)` takes an arbitrary dice formula (`schemas.py` line 58); `skill_check(dc)` and `apply_condition` take free text names. ADR-004/architecture §3.2 explicitly forbids exactly this ("no 'roll arbitrary dice' tool", "no direct HP edits").
  - Entities are addressed by Foundry `actor_uuid`/`token_id`, not catalog IDs.
  - `ExecuteJSAction` (schemas.py ~441-484) is arbitrary code execution gated only by a flag; **must not exist** in the new product.
- **Mapping of the ~25 mechanically meaningful actions onto the architecture tool list (§3.2):** `skill_check`/`passive_check` -> `request_check`; `saving_throw`/`environmental_save`/`use_save_item` -> `request_save`; `grapple`/`opportunity_attack` + `attack_with_item` -> `attack`; `cast_spell` -> `cast_spell`; `apply_condition` -> `apply_condition`; `start_encounter`/`end_encounter` -> `start_combat`/`end_combat`; `short_rest`/`long_rest` -> `call_for_rest`; `death_save`/`grant_inspiration`/`set_exhaustion` -> engine-internal (not LLM tools); `generate_treasure/npc/quest/encounter` -> catalog-bounded engine helpers (`actions/generation_actions.py`, 435 lines, **not read in detail**). `narrate`/`speak` collapse into streamed narration with NPC attribution.
- **Verdict:** write new TS zod schemas for the architecture's ~16 tools. Reuse the *test ideas* (reject unknown fields, clamp, retry) not the code.

### 2.2 Combat loop and timeouts: **Redesign, keep three ideas**
- **Evidence:** `combat/loop.py` (1,518 lines). `CombatLoop._process_npc_turn` wraps the LLM call in `asyncio.wait_for(..., timeout=llm_combat_timeout)` (default 60 s; lines ~713-732) and on `TimeoutError` runs `_generic_npc_behavior` -> `_deterministic_npc_actions` (lines 811-852): nearest PC, first attack item, no LLM. `_wait_for_pc_input` caps the wait on `pc_turn_timeout` (default 180 s via `config.py`; loop lines 908-947) and skips the turn with a chat line. `_reaction_window` waits up to 60 s (line ~988). Solo death -> `_maybe_apply_solo_death_setback` (lines 1167-1204) turns lethal outcomes into a "captured" setback. Degraded mode when the token budget is exhausted (`enter_degraded_mode`, `_execute_degraded_npc_turn`, lines 854-905).
- **Reusable ideas:** (a) LLM-call timeout with a **deterministic fallback turn** matches architecture §2.4's "engine monster policy" and R-R2's safe fallback; (b) AFK turn skip maps to the 90 s -> Dodge rule (US-B2); (c) budget-exhausted degraded mode matches spec §9.2 80%/100% degradation; (d) solo setback is a good product idea for US-B3 "fail-forward".
- **Not reusable:** turn order is read from Foundry's `Combat` document (`_fetch_initiative_order`, `_sync_foundry_combat`), positions are grid coordinates, and `combat/mechanics.py` (347 lines, flanking/cover/reach by grid distance) contradicts A5 (range bands, no grid). Reaction handling is a chat-window hack, not the engine-emitted `ReactionAvailable` event of §2.4. Timeouts here are 60/180 s versus the spec's 90 s party / 15 s reaction, and they are **config constants in a loop**, not Room-owned state machine timers.
- `combat/difficulty.py` (279 lines): DMG XP-by-CR table and encounter multipliers, pure Python and Foundry-free. **Port** to the engine, but see licensing: DMG multiplier math is **not SRD 5.1 text verbatim**; re-derive from SRD 5.2.1's encounter guidance before shipping (**not verified** which parts SRD covers).
- `combat/tactics.py` (204 lines) is a candidate seed for "monster policy" (target selection); **only header read**.

### 2.3 Rules engine / 5e reference: **Drop code; Port small tables**
- **Evidence:** `rules/engine.py` (115 lines) exposes `get_spell`, `get_condition`, `calculate_proficiency_bonus = (level+7)//4`, `suggest_dc`, skill->ability map. `rules/database.py` (143 lines) holds 14 conditions as one-line paraphrases and a "sample for demonstration" spell dict (comment at `rules/database.py` "Common spells by level (sample for demonstration)").
- It does not roll dice, track slots, apply damage types, or run initiative. No server-side RNG exists in `actions/`, `combat/`, `rules/`, or `procedural/` as far as my greps showed (grep for `random.randint/choice` was **inconclusive**: the shell glob errored, so treat "no RNG" as inferred from `roll` being delegated to `foundry.roll`, `actions/executors.py` lines 252-292, and from `players_roll_own=True` deferring PC rolls to humans).
- **Verdict:** nothing here substitutes for M1 "Engine core". Keep only the DC band table (`DC_BY_DIFFICULTY`) and proficiency formula; both are trivial. **The repo gives you zero head start on the hardest, most valuable module** (architecture §8 rationale).
- Notable inversion: the old design **deliberately lets players roll their own dice** (`execute_roll`, `config.py` line 189) whereas the spec mandates server dice (R-D1). Different product premise (in-person table vs web game).

### 2.4 Campaign builder: **Redesign (idea), Drop (implementation)**
- **Evidence:** `campaign/` is 16,818 lines across ~30 files: `generator.py` 1,953 (LLM -> campaign structure), `orchestrator.py` 1,521 + `orchestrator_{import,deploy,assets,enrich}.py` (~3.9k), `importer.py` 1,429 (ingests published campaign PDFs/folders via pypdf), `map_generator.py` 1,214, `layout_generator.py` 887, `obsidian_sync.py` 896, `campaign/modules/*` (35 Foundry-module adapters: midi_qol, item_piles, simple_calendar, ...), `checkpoints.py` (atomic build resume).
- **Only transferable ideas:** staged build with an atomic checkpoint/resume (`BuildCheckpoint`, README line ~272); a `generator.py` prompt shape that yields an adventure skeleton. Spec §8 wants 3 hand-authored adventures as **data by catalog ID** and defers authoring tools to Phase 3, so a builder is out of MVP scope anyway.
- **Hard blockers for reuse:** deploy targets Foundry documents (scenes, journals, actors, loot tables, quest logs); `importer.py` exists to ingest **commercial published adventures** (README mentions "commercial D&D books"), which is the opposite of the SRD-only/original-content stance in spec §8 and architecture §7. Output goes to an Obsidian vault.
- **Not read in detail:** `generator.py` prompts, `story_enricher.py`, `prologue.py` (291, a possible "session zero" prompt source).

### 2.5 Lore / vault memory: **Port the layered-memory design; Drop vault + embeddings**
- **Evidence:** `context/campaign_memory.py` (424 lines, header read). Docstring: raw rows append-only; level-1 summary every N turns; level-2 session summary; **facts** (`promise, debt, injury, item, death, relationship, secret, quest`) held separately so compaction can't blur them; an always-visible **topic index**; details retrieved only when the player's message names a topic; summaries are disposable and rebuildable from raw rows; compaction runs off the player's turn. This maps almost one-to-one onto architecture §4 (registry facts, append-only scene summaries rebuildable from the log, deterministic entity-name injection, retrieval cap) and ADR-006.
- `context/canon.py`: end-of-session "canon proposals" with confidence and contradiction flags, human-approved (`canon_proposals` table in `persistence/db.py`). Good fit for the P1 operator/host review and for the R-M3 contradiction guard. In the new design the registry is written via tools, so this is a *secondary* check.
- `vault/` (721 lines: `indexer.py` HNSW + QueryCache, `embeddings.py` OpenAI/Ollama/sentence-transformers providers, `vault_semantic_rag.py`): the architecture **defers vectors** (D10: Postgres FTS, no vector store at launch). **Drop for MVP**; revisit only if US-E3 recall evals fail. `QueryCache` is a nice small LRU if needed later.
- **Verdict:** Port `campaign_memory.py` logic into the `memory` module in TS with Postgres FTS in place of SQLite and the vault. Keep the fact-kind taxonomy.

### 2.6 NPC chat: **Port**
- **Evidence:** `npc/chat.py` (118 lines): a `/npc <name>: <message>` side-channel with a short in-character system prompt, last 6 turns, an LRU of 64 conversations, fuzzy single-NPC name resolution (`_resolve`), grounded on the NPC record, memory lines (5), and nearest lore. `npc/registry.py` (338), `npc/personality.py` (229), `npc/memory.py` (46), `npc/goals.py` (41).
- **Fit:** spec has no NPC-chat requirement in MVP; the closest is R-M4 "Lore Q&A" (P1) and the registry. The prompt (`SYSTEM_PROMPT`, chat.py lines ~26-33) is a good small asset for "talk to NPC" and "Lore Q&A answered only from registry/transcript." `NPCRegistry` shape (name, description, relationships, goals) is a useful superset to inform `World.npcs[]` in architecture §3.4 (disposition, facts, lastSeen).
- **Caution:** `personality.py` parses NPC descriptions with regex heuristics ("_extract_traits"); skip. `worldclock/`, `world_tick/`, `orchestrator/director.py` (NPC goals/ticks, "SceneDirector") are living-world features outside the MVP; **Drop** for now.

### 2.7 Undo: **Redesign**
- **Evidence:** `actions/undo.py` (157 lines). In-memory `deque` of 50 restore points for `update_hp`, `move_token`, `apply_condition`, `set_exhaustion`; undo restores the **exact prior HP** rather than inverting damage (because Foundry clamps), serializes with an `asyncio.Lock`, and drops the entry only after readback verification. The ledger is lost on restart (module docstring says so).
- **Why redesign:** the architecture's rewind (R-S7, §5, ADR-003) restores a **whole-turn snapshot** and appends `TurnReverted`; it is event-sourced and durable, not per-action compensation. The repo's compensating-action approach exists only because Foundry is the state of record and cannot be snapshotted. The two durable lessons: (1) verify the restore by readback; (2) restore exact prior values, don't invert. Both are subsumed by snapshot restore.
- Only 4 of 47 actions are undoable; the new design covers everything.

### 2.8 TTS narration: **Port pieces; Redesign delivery**
- **Evidence:** `tts/` 911 lines: `service.py` (287, strips markdown, POSTs to an OpenAI-compatible `/v1/audio/speech`, caches by hash, prunes files), `voice_assigner.py` (210, 15 archetype voices, deterministic assignment stored on the NPC record, narrator reserved as `fable`), `playback.py` (410, sentence splitting, Foundry AudioHelper playback, or Web Speech API fallback via `_browser_payload`).
- **Reusable:** markdown stripping (`_MARKDOWN_RE`), sentence splitting (`_split_sentences`, **useful for the output-gate sentence-chunking in architecture §6**), archetype->voice indirection, and the **browser Web Speech fallback** (zero-server, a11y-friendly, aligns with spec §9.3 P1 "optional TTS"). Voice assigner is deterministic keyword/class heuristics keyed on class names and gender cues (`_detect_gender`), which will need review for sensible, non-stereotyping defaults before reuse.
- **Not reusable:** playback pushes audio into Foundry via `foundry.client`; the server-generated audio route (`/audio/<name>`, unauthenticated by the README's own admission) must be redesigned with session auth. Default recommendation: **browser `speechSynthesis` for MVP P1**, server TTS only if quality demands it.
- Model licensing: voices come from user-run servers (Kokoro, Voxtral named in README line ~30); **their licenses were not checked**.

### 2.9 ComfyUI map/portrait generation: **Port prompts and workflow; Drop plumbing**
- **Evidence:** `campaign/map_generator.py` (1,214): SDXL workflow (`SDXL_CHECKPOINT = "dDBattlemapsSDXL10_upscaleV10.safetensors"`, `control-union-sdxl-1.0.safetensors` ControlNet, 2x hires pass `_append_hires`), style prefixes with notes that "without them a quarter to a third of the frame came out solid black", portrait framing 512x640, ComfyUI input-dir autodetection. `campaign/cinematic_art.py` for z-image and LTX-Video stills/clips; `campaign/layout_generator.py` + `procedural/layout_gen.py` draw layouts used as ControlNet input.
- **Fit:** spec Phase 2 lists "scene illustrations"; maps are a non-goal for MVP (no battle-map VTT, A5). Portraits and scene stills are the realistic carry-over; the hard-won prompt/negative-prompt tuning in `_STYLE_PREFIXES` and the portrait framing are worth keeping as data. Grid-snap and wall/token placement code is Drop.
- **Operational note:** this requires a local ComfyUI + GPU (Apple Silicon timings in docs: "~40 s" per still), so it is a **self-hosted, offline-batch** feature, not something a 200-session web service can call inline. Prefer pre-generating art for the 3 authored adventures.
- **Licensing flag:** the SDXL checkpoint `dDBattlemapsSDXL10` is a **third-party community model**; its license and commercial-use terms were **not checked** and the file is not in the repo. The z-image, LTX-Video 2B, and ControlNet-union model licenses were also **not checked**. Do not ship generated assets commercially until those are verified.

### 2.10 Event log / audit trail: **Port the concept (events + reducers + audit record)**
- **Evidence:** `events/types.py` (155): typed events with pure reducers that return a new state (`REDUCERS`), `events/store.py` (48): append + `replay`, `events/replay.py` (188): transcript and state-at-index queries. `persistence/db.py` (723): SQLite `events(id, session_id, campaign, description, type, payload, timestamp)`, `ai_conversations` (immutable raw record, never retention-deleted), `llm_usage`, `canon_proposals`, `session_info`; `EVENT_RETENTION_DAYS = 60`. `actions/audit.py` (133): `CONSEQUENTIAL_ACTIONS` classification plus a bounded one-line params summary, folded into the `ACTION_RESOLVED` event by the dispatcher. `migrations.py` (194): versioned migrations.
- **Fit/gaps:** concept matches ADR-003 (append-only log, replay). Differences: the old reducers cover only NPC moves, relationships, canon facts, time, factions, `ACTION_RESOLVED`; **they do not cover HP/inventory/slots**, because Foundry owned those. No `seq` per session, no turn IDs, no snapshot-in-same-transaction, no roll log with seed and breakdown (R-D1, §3.3). SQLite via `aiosqlite` -> Postgres is a rewrite.
- **Good, copyable practice:** audit classification set with a test asserting every name is a real handler (the file documents a past drift bug where "nine names ... no longer existed", `actions/audit.py` docstring) -> add the same invariant test for the new tool registry.

### 2.11 Admin panel: **Redesign**
- **Evidence:** `ai-engine/admin-panel/` React 18 + Vite + zustand; 5,252 non-test lines. Pages: Dashboard, SessionViewer, GMChat, CampaignBuilder/Start, CanonReview, NPCManager, Downtime, Overrides, Settings, SetupWizard (`src/pages/`). `store.js` 1,102 lines; the repo's own `docs/architecture-refactor.md` calls out `store.js` as "29 fetch helpers, all the same 13-line ... shape" and notes duplicated action-panel state machines (statement from the doc, not independently verified).
- **Fit:** spec has an **operator** persona (cost caps, mod queue; P1 dashboard) and a host panel. The UX *patterns* (live session view over WebSocket, canon review queue, decision/action log viewer, token budget meter) are useful wireframe input. Stack alignment is good (React/Vite, ADR-001), but pages are bound to Foundry/campaign-deploy concepts and to `localhost` + optional bearer token (`ADMIN_TOKEN`), which is far weaker than the guest/host/operator authz in spec §9.5.
- **Verdict:** do not copy components. Reuse as a **feature checklist** (SessionViewer, CanonReview, usage meter).

### 2.12 LLM manager, routing, usage: **Port ideas**
- **Evidence:** `llm/manager.py` (720; **read lines 1-60 plus symbol list only**), `llm/router.py` (25): `ModelRouter` with `frontier`/`npc` tiers; `llm/usage.py` (57): `TokenUsage.before_call` preflight against a per-session token budget, raising `TokenBudgetExceeded`, with durable `llm_usage` rows; `_template_safe` folds multiple system messages for Qwen-style templates; `generate_stream` exists.
- **Fit:** closely matches ADR-009 (tiering + cost caps) and the §9.2 cost meter. Port the preflight-budget + `on_exhausted` callback shape. Provider is OpenAI-compatible HTTP to local oMLX/LocalAI (`openai==1.50.0`, `httpx`), so adapt to the Anthropic SDK with prompt caching per architecture §4/§9. `reinforcer.py`/`reinforcement_manager.py` (periodic system reminders to fight drift) are worth a look for long sessions; **not read**.
- JSON-in-text action parsing (`_extract_json`, `utils/json_extract.py`) is the weak spot: the new design should use native tool calling instead.

### 2.13 Referee: **Drop**
`referee/agent.py` (111 lines, read fully): clamps DCs to the nearest of the standard bands within +/-5, and rejects `cast_spell` when no slot exists, reading slots from Foundry, failing **open** ("adjudication error ... approves the action unchanged"; "fail open rather than block"). The new engine owns legality and fails **closed** (error + retry + safe fallback, R-R2). Keep only the idea of DC sanity bands as a catalog guard.

### 2.14 Evals / replay harness: **Port design and scenarios**
- **Evidence:** `evals/README.md` (read first 40 lines), `evals/harness.py` (463): `MockFoundryClient` and `ScriptedLLM` drive the full pipeline; `evals/replay.py` (520) runs `--backend scripted` (deterministic, CI) or `--backend live`; 30 scenario JSONs in `evals/scenarios/` (e.g. `canon_dead_npc_stays_dead`, `combat_rolls_for_npc_only`, `death_save_prompt`, `goblin_ambush`); `evals/contradictions.py` (event-log vitality detector: a dead NPC may not speak), `evals/judge.py` (opt-in temperature-0 LLM judge), `evals/metrics/history.jsonl`, `baselines/`.
- **Fit:** this is the most directly valuable asset. It is the "recorded/mock LLM + scripted scenarios + contradiction metric" pattern that architecture §10 and ADR-012 call for (US-E3 consistency, puppeting, narration-vs-tool agreement). Port the **scenario format and the dead-NPC/canon detectors**; swap the mock Foundry for the Room/engine and add seeded dice. The scenario JSONs are Foundry-flavoured (fixtures are actors/tokens); rewrite fixtures, keep intent and names.
- **Gap:** no rules-Q&A eval, no red-team/injection set, no puppeting detector, no latency/cost gate; these remain new work.

### 2.15 Foundry-specific code: **Drop**
`foundry/chat_listener.py` 2,978, `foundry/client.py` 2,316, `foundry/scripts.py` 976 (JS snippets), `relay_proc/manager.py` 1,107 (spawns and supervises the Go relay), `immersion/` 1,367, `scene/awareness.py` 280, `campaign/modules/*`, `foundry-module/` (2,521 lines of JS Foundry modules), `launcher/` (macOS rumps menu bar app), `AI GM.app`, `backups/`. None apply. `chat_listener.py` is also where the LLM-output -> dispatcher loop, `/gm` commands, and the player-turn pacing live; its interesting logic (pacing, retry on failed action) would be re-derived from the architecture's Room instead.

## 3. Third-party code and licensing

| Item | Finding | Evidence |
|---|---|---|
| Repo license | **MIT**, (c) 2025 Chris Kennedy. Human owns it, so reuse of own code is unrestricted. Any third-party MIT parts must keep notices. | `LICENSE` (first lines read) |
| Relay (Go submodule) | Forked from ThreeHats/foundryvtt-rest-api-relay, **MIT** per README; submodule is **not checked out** in the clone (`git submodule status` shows `-607db6c...`), so `relay/LICENSE` **not verified by me**. Irrelevant to the new product since it's Foundry glue. | `README.md` lines ~332, 420; `.gitmodules` |
| Foundry module `foundryvtt-rest-api` | Third-party (same upstream author) required by the old product; license not read. Drop with Foundry. | README line ~119 |
| Python deps | fastapi, uvicorn, openai, httpx, pydantic, aiosqlite, websockets, Pillow, pypdf: permissive licenses as I recall, but **I did not verify** each. `rumps` (macOS launcher) irrelevant. | `ai-engine/requirements.txt` |
| Embeddings | optional sentence-transformers (Apache-2.0 as I recall, models have own licenses); **not verified**. | `requirements-embeddings.txt` (name only) |
| Admin panel deps | react, zustand, react-markdown, vite, vitest: permissive; **not verified**. | `admin-panel/package.json` |
| Image/video models | SDXL checkpoint `dDBattlemapsSDXL10_upscaleV10`, `control-union-sdxl-1.0`, z-image turbo, LTX-Video 2B: **licenses unchecked, commercial-use unknown**. Flag before shipping any generated art. | `campaign/map_generator.py` lines 43, 155; README lines ~22-23 |
| D&D content | `rules/database.py` holds paraphrased conditions and "sample" spells; `combat/difficulty.py` holds DMG XP-by-CR and multiplier tables; `combat/compendium_generator.py` pulls monsters from **Foundry's dnd5e compendium** (the world's installed data, which may include non-SRD material). **No SRD attribution exists anywhere I looked.** Nothing here may be assumed SRD-clean; regenerate from SRD 5.2.1 text (architecture §7, D1). | files named; attribution search was a grep that errored, so "no attribution" is **inferred, not confirmed** |
| Commercial content ingestion | `campaign/importer.py` is built to ingest commercial adventure PDFs (README + comment about AES-encrypted commercial books). Strike from the new product for IP reasons (spec §8). | `requirements.txt` comment; `importer.py` header |
| Non-SRD proper nouns in prompts | A grep for beholder/mind flayer/Faerun errored (shell glob), so **not checked**. Review `llm/system_prompts.py` and `procedural/*` before porting any prompt text. | n/a |

## 4. Paid-plugin and platform coupling

- **FoundryVTT itself is a paid product** (license purchase required; the README demands "FoundryVTT v14 + D&D 5e system"; the nightly CI even uses `FOUNDRY_USERNAME`/`FOUNDRY_PASSWORD` secrets to run a dockerized Foundry, README line ~259). Entire runtime is coupled: `foundry/client.py`, `scripts.py`, `relay_proc/`, `foundry-module/`.
- **Module-level coupling (35 adapters in `campaign/modules/`):** midi-qol, DAE, AutoAnimations, item-piles, Simple Calendar, Storyteller Cinema, StoryTeller X, Monk's Token Bar, fxmaster, dice-so-nice, levels, lootsheet-simple, RPGX quest log, etc. (README line ~33 says "and 19 more"). Several are community modules, a few are paid or Patreon-gated; **I did not verify which**. All Drop.
- **Hidden coupling to dnd5e system internals:** combat resolution relies on the dnd5e v5/6 Activity API (`activity.rollAttack/.rollDamage`, `actor.applyDamage`, `foundry/scripts.py` docstring of `resolve_item_attack`). That implicit rules implementation is **Foundry-owned and not portable**.
- **Local-model coupling:** defaults to local oMLX/LocalAI endpoints (`?thinking=false` query param "required for oMLX", `llm/manager.py` line ~59), Obsidian vault paths, macOS-only launcher. Not an issue for the new product but any copied code needs these stripped.
- **Security posture:** loopback-only admin by default, optional bearer `ADMIN_TOKEN`, `/audio` and static admin unauthenticated (README states this). Insufficient for a public multi-tenant web game.

## 5. Conflicts with the new architecture and ADRs

| # | Old repo behavior | New requirement | Impact |
|---|---|---|---|
| C1 | **LLM mutates state broadly.** `update_hp` with LLM-chosen damage (-200..500), arbitrary `roll` formula, `apply_condition`, `set_exhaustion`, `execute_js`, `place_token`, scene reshaping. The module itself concedes "Reshaping the world in response to what players type IS the product" and that the allowlist "cannot be the defence against prompt injection" (`actions/schemas.py`, the `PLAYER_BLOCKED_ACTIONS` docstring). | ADR-004 / §3.1-3.2 / R-S3: LLM only proposes typed tool calls; engine owns every number; no HP/dice tool; text is intent, never state. | **Fundamental.** Cannot port `executors.py` (2,048 lines) at all. Reuse schemas' *shape* only. |
| C2 | **State of record is Foundry**, not our DB; HP/slots read live from sheets; the engine keeps only a thin `game_state` KV and events. | ADR-002 single-writer Room + ADR-003 snapshots; `Character`, `Combat`, `World` schema in §3.4. | Old persistence is not a model for state; it models only memory/events. |
| C3 | **Dice by Foundry / by players**; PC rolls deferred to the human. | R-D1 server CSPRNG + seeded per-turn stream; roll log with breakdown (§3.3). | No overlap; build new. |
| C4 | **Referee fails open**; engine errors approve the action. | R-R2: reject, retry <=2, then safe fallback with **no state change**. | Opposite policy. |
| C5 | **Undo = per-action compensation, in-memory, 4 action kinds.** | R-S7 / ADR-003: snapshot restore, durable, whole-turn, new seed on retry (D5). | Redesign. |
| C6 | **Single GM, autonomous, no safety layer.** Players are trusted table members; there is no input/output moderation, no X-card, no SRD denylist. | §6 moderation gate, X-card, hard floor, SRD entity scan (ADR-007, ADR-008). | Net-new; nothing to reuse. |
| C7 | **Turn model:** chat-driven free flow with pacing delays; combat turn order from Foundry; PC wait 180 s, NPC LLM timeout 60 s. | ADR-005: collect-then-resolve rounds, Room timers (120 s explore / 90 s combat / 15 s reaction), engine-owned initiative, monster policy, away autopilot. | Port only the timeout+fallback idea. |
| C8 | **Single table, single process, SQLite, global singletons** (`app_state`, one `dispatcher`, one `LLMManager` conversation history). | 200 concurrent rooms, Postgres, one Room actor per session. | State is process-global; unsafe to lift into a multi-tenant server. |
| C9 | **JSON-in-text action protocol** parsed with `_extract_json`. | Native tool calling with schema validation (§3.2). | Replace; `llm/system_prompts.py` action table becomes tool descriptions. |
| C10 | **Free-text entities** (NPC names, spell names, scene names) resolved by fuzzy match to Foundry docs. | Catalog IDs only (§3.2, ADR-008). | Redesign data model. |
| C11 | Memory is **Obsidian vault + HNSW embeddings** (`vault/`), campaign-lifetime. | D10: Postgres FTS, no vectors at launch (ADR-006). | Drop vault; port layered summary logic only. |
| C12 | Language: Python 3.11-3.14, Node 24 for panel, Go for relay. | ADR-001: TS monorepo with shared pure engine. | Everything "ported" is a rewrite. If the human later prefers Python (architecture Alt B), the reuse score rises somewhat but the engine duplication problem remains. |

## 6. What was and was not read

**Read in full or substantially:** `actions/dispatcher.py`, `actions/undo.py`, `actions/audit.py`, `actions/executors_shared.py`, `actions/schemas.py` (lines 1-200, 430-758, i.e. the schema tail and dispatch table; the middle 200-430 not read), `rules/engine.py`, `referee/agent.py`, `events/store.py`, `orchestrator/director.py`, `state/models.py`, `llm/router.py`, `llm/usage.py`, `LICENSE`, `.gitmodules`, `requirements.txt`, README lines 1-120 plus grep hits, repo `docs/architecture-refactor.md` first 30 lines.

**Read partially (header, signatures, or a key section):** `actions/executors.py` (`execute_roll`, `execute_update_hp`, handler table only; 2,048 lines total), `combat/loop.py` (structure, NPC-turn timeout path, fallback, PC wait, solo setback, degraded mode), `combat/mechanics.py` (first 80 lines), `combat/difficulty.py` (first 45 lines), `combat/compendium_generator.py` (header), `rules/database.py` (first 60 lines), `events/types.py` (first 80), `events/replay.py` (first 50), `persistence/db.py` (schema section), `llm/manager.py` (first 60 + symbol list), `llm/system_prompts.py` (first 40), `context/campaign_memory.py` and `context/canon.py` (docstrings), `npc/chat.py` (first 50), `npc/registry.py` (first 30), `tts/service.py` (first 40), `tts/voice_assigner.py` (first 30), `tts/playback.py` (symbol list), `campaign/map_generator.py` (first 50 + greps), `campaign/orchestrator.py` (docstring), `campaign/importer.py` (header), `vault/indexer.py` and `vault/embeddings.py` (headers), `evals/harness.py` (first 40), `evals/README.md` (first 40), `foundry/scripts.py` (first ~75 + function list), `procedural/settlement.py` (header), `scene/awareness.py` (header), `admin-panel/package.json` and page listing, `api/routes/undo.py` (first 30).

**Not read:** `foundry/chat_listener.py`, `foundry/client.py`, `campaign/generator.py`, `campaign/orchestrator_*.py`, `campaign/layout_generator.py`, `campaign/obsidian_sync.py`, `campaign/modules/*`, `actions/generation_actions.py`, `combat/tactics.py` (beyond header), `context/loader.py`, `context/reinforcer*.py`, `immersion/*`, `procedural/*` (beyond header), `downtime/`, `world/`, `world_tick/`, `worldclock/`, `relay_proc/`, `api/` (except `undo.py` head), all `admin-panel/src` source, `foundry-module/`, `launcher/`, `docs/` beyond the two files above, `ai-engine/tests/`, `evals/scenarios/*.json` contents, the Go relay submodule (not cloned).

**Checks that failed or were inconclusive:** three recursive `grep --include=*.py` commands errored in the zsh shell because of unquoted globs, so the claims "no server-side RNG", "no SRD attribution", and "no non-SRD proper nouns audited" are **inferred from the files I did read, not exhaustively confirmed**. Run `rg -n "random\.|SRD|beholder|mind flayer|Forgotten Realms" ai-engine` to close these before relying on them.

Counts and sizes are `wc -l` on `git ls-files` output; the "~8k plausibly portable lines" figure at the top is my estimate, not a measurement.

## 7. Recommended reuse plan (smallest useful set)

Ordered by value per effort, mapped to milestones in architecture §11:

1. **M2 eval harness v0** (ADR-012): port the scenario/replay/contradiction design (`evals/*`) onto a recorded-LLM mode. Highest return.
2. **M2 memory v1** (ADR-006): port `context/campaign_memory.py` layering (raw -> L1 -> L2, fact kinds, topic index, rebuildable summaries) to TS + Postgres FTS; port `context/canon.py` as the P1 review queue.
3. **M2 tool contract**: write ~16 new zod tools per §3.2; borrow dispatch pipeline order, `extra=forbid`-style strictness, clamping tests, the "every audited name is a real handler" invariant test.
4. **M2/M3 orchestrator**: take the budget-preflight + degrade-on-exhaustion shape from `llm/usage.py` and `combat/loop.py` degraded mode for the §9.2 cost meter; use native tool calling, not JSON-in-text.
5. **M4 combat**: take the timeout -> deterministic fallback and solo-setback ideas; build engine-owned initiative/monster policy fresh.
6. **P1 (Phase 2)**: TTS via browser `speechSynthesis` with `voice_assigner` archetype idea; art via pre-generated ComfyUI portraits/stills once model licenses are verified.
7. **Do not port:** `executors.py`, `foundry/*`, `campaign/*` deploy/modules/importer, `vault/*`, `immersion/*`, `referee/*`, `combat/mechanics.py` grid logic, admin-panel source.

Open decisions for the human:
- Confirm Python vs TS reuse stance (C12): if "reuse code" outranks "shared engine", Alt B in architecture §8 changes the calculus.
- Provide or confirm licenses for the SDXL/ControlNet/z-image/LTX models before any generated art ships.
- Confirm the old project's maintainers won't object to the Foundry-derived prompt text being used in a public, differently licensed product (it is the human's MIT repo, so likely fine; the relay fork is separate).
