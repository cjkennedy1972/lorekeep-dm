# Product Requirements Spec: AI Dungeon Master (working title "Lorekeep-DM")

Status: Draft v0.1 · Date: 2026-10-06 · Owner: Compass (Product & Requirements)
Scope: spec only. No implementation, no external messaging.

Conventions: **[A#]** = labeled assumption (see §14). **[Q#]** = open question (see §13). Priorities: **P0** = MVP must, **P1** = MVP should / fast-follow, **P2** = later.

---

## 1. Problem and vision

Running D&D needs a Dungeon Master, a scheduled group, and rules fluency. Many people who want to play have none of the three. Existing AI-text-adventure tools lack real rules adjudication, dice integrity, party play, and campaign continuity.

**Vision:** a browser game where 1–6 people open a link and play a rules-faithful (5e SRD) D&D session run by an AI DM that narrates, adjudicates, rolls honest dice, remembers the story, and respects safety settings.

**Non-goals (MVP):** native mobile apps, voice/video chat, user-generated content marketplace, homebrew rules editor, battle-map tactical VTT with fog of war, non-SRD content, human-DM mode, monetization/billing, tabletop-publisher licensed settings.

## 2. Personas

| ID | Persona | Description | Needs |
|---|---|---|---|
| P-Solo | **Sam, the solo adventurer** | Wants D&D without a group; plays 30–90 min sessions, often at night. | Instant start, a DM that adapts, no rules homework, resume later. |
| P-Host | **Harper, the party host** | Organizes a friend group (2–6), usually remote. Technically comfortable. | Easy invite, control over who joins, pacing, safety settings, kick/mute. |
| P-Newbie | **Nia, the first-timer** | Joins via invite link, has never played. | Guided character creation, plain-language explanations, no jargon walls. |
| P-Vet | **Vic, the veteran player** | Knows 5e, distrusts AI DMs. | Correct rules, visible dice/math, ability to challenge a ruling. |
| P-Access | **Alex, the accessibility-dependent player** | Screen reader and/or keyboard-only, or dyslexia/low vision. | Fully operable and readable UI; no timing pressure. |
| P-Admin | **Operator** (internal) | Runs the service. | Cost caps, moderation queue, abuse controls, observability. |

## 3. Core user stories and acceptance criteria

Format: story, then acceptance criteria (AC). All AC are testable.

### 3.1 Solo

**US-S1 (P0) Start a solo game fast.** As Sam, I start a solo adventure without account friction.
- AC1: From landing page to first DM narration in ≤ 3 minutes including character creation via "quick start" path.
- AC2: Guest play allowed; session is saved to a device-bound token, with prompt to claim via account/email [A3].
- AC3: Solo mode never blocks waiting on other players.

**US-S2 (P0) Solo is balanced for one.** As Sam, encounters are tuned for a single character (optionally with 1–2 DM-controlled companion NPCs).
- AC1: Encounter generator takes party size/level as input and uses SRD encounter-difficulty guidance; solo default difficulty "moderate" targets ≥ 70% character survival over a 10-encounter playtest set [A9].
- AC2: Player can toggle companion NPC on/off at lobby.

**US-S3 (P0) Resume.** As Sam, I return days later and continue.
- AC1: Reopening the session link restores character sheet, inventory, HP, location, quest log, and a "Previously on…" recap (≤ 150 words) before first new narration.
- AC2: Resume works after browser close, device change (via account), and server redeploy.

### 3.2 Party (2–6)

**US-P1 (P0) Create and invite.** As Harper, I create a party session and share an invite link.
- AC1: Creating a session yields a join URL and 6-char code in ≤ 2 clicks.
- AC2: Link supports 1–6 seats; 7th joiner sees "party full" and an option to spectate if host enables it [Q6].
- AC3: Host can revoke/regenerate link; old link stops working immediately.

**US-P2 (P0) Join with no friction.** As Nia, I join through a link on any modern browser.
- AC1: Guest join with display name only; no install.
- AC2: Joiner lands in lobby showing party, host, and safety settings summary.

**US-P3 (P0) Everyone plays a character.** As any player, I create or import my own character.
- AC1: Each seat has exactly one active PC (see §4.2).
- AC2: Lobby shows per-seat readiness; host can start only when ≥ 1 PC is ready, with warning for unready seats.

**US-P4 (P0) Shared scene, fair spotlight.** As a player, I get meaningful agency in a group.
- AC1: DM addresses players by character name and, in any 6-player scene lasting ≥ 10 DM turns, each non-idle player receives ≥ 1 direct prompt [A8].
- AC2: Per-player action queue is visible; I can see who has/hasn't submitted.

**US-P5 (P0) Drop in/out.** As a player, I can disconnect/rejoin without breaking the session.
- AC1: Disconnect > 30 s flags the PC "away" and the DM auto-runs it per §6.4; rejoin restores control within 2 s of reconnect.
- AC2: A new player can join mid-session at a safe point (§6.4).

**US-P6 (P0) Host controls.** As Harper, I can manage the table.
- AC1: Host can pause/resume, kick, mute a player, transfer host, end session, change safety settings, and set turn-timer mode.
- AC2: Kicked player cannot rejoin with the same link without host re-invite.
- AC3: If host disconnects > 2 min, host role auto-transfers to the longest-connected player (configurable off).

### 3.3 Character

**US-C1 (P0) Guided creation.** As Nia, I build a legal SRD character step by step.
- AC1: Flow: race/species → class → ability scores (standard array / point buy / rolled) → background → equipment → name/personality. Every choice has a one-line plain-language explanation.
- AC2: Validation: sheet cannot be saved if it violates SRD rules (e.g., point-buy cap, invalid proficiencies).
- AC3: "Quick build" produces a legal, level-1 pre-built PC in ≤ 2 clicks.

**US-C2 (P0) Live sheet.** As any player, I see my sheet update as the game proceeds.
- AC1: HP, conditions, slots, inventory, and XP/level changes reflect within 1 s of the authoritative event.
- AC2: Level-up flow triggers at SRD XP thresholds (or DM milestone) and enforces legality.

**US-C3 (P1) Import/export.** Export character as JSON; import a previously exported SRD-legal character.
- AC1: Round-trip export→import yields identical sheet; illegal imports are rejected with specific error messages.

### 3.4 Exploration and roleplay

**US-E1 (P0) Free-text actions.** As a player, I describe what I do in natural language.
- AC1: DM responds to a valid action within the latency targets (§9).
- AC2: If an action is ambiguous, DM asks one clarifying question rather than guessing, at most once per action.
- AC3: Player can also use quick-action buttons (Look, Talk, Search, Move, Use item, Cast).

**US-E2 (P0) Skill checks that feel fair.** As Vic, I see how rolls are decided.
- AC1: DM calls for a check with ability/skill and DC reasoning shown on request ("why DC 15?").
- AC2: Roll result, modifiers, and outcome are displayed; roll is performed by server RNG, never the LLM (§7.3).

**US-E3 (P1) Persistent world.** As a player, NPCs and places stay consistent.
- AC1: In a 3-session regression script, named NPCs retain name, role, disposition, and key facts with ≥ 95% consistency as judged by an automated fact-check set [A10].

### 3.5 Combat

**US-B1 (P0) Structured combat.** As a player, combat follows SRD initiative and action economy.
- AC1: Initiative rolled by server for all combatants; order displayed.
- AC2: Each turn offers action, bonus action, movement, reaction; used resources are tracked.
- AC3: Attack rolls, damage, saves, and conditions applied per SRD by rules engine; DM narrates results.

**US-B2 (P0) Simultaneous-turn handling.** (See §6.2.) In party combat, only the active combatant's inputs are accepted for their turn, except reactions and out-of-character chat.
- AC1: Non-active player attempting an action receives "not your turn" and, if relevant, a reaction prompt when one triggers.
- AC2: Turn timer (default off for solo, 90 s default for party, configurable) auto-"Dodge/hold" on expiry.

**US-B3 (P0) Death and unconsciousness.** Dropping to 0 HP triggers SRD death saves; solo TPK offers retry-from-checkpoint or "narrative fail-forward" (host/solo choice).
- AC1: Death saves rolled by server; 3 successes stabilize, 3 failures kill, per SRD.
- AC2: Any PC death produces a recorded event and an offered resurrection/new-character path.

### 3.6 Rest and persistence

**US-R1 (P0) Short and long rests.** As a player, I take rests per SRD.
- AC1: Short rest allows hit-dice spending; long rest restores HP/slots/hit dice per SRD; DM can inject rest interruptions (random encounter) with a configurable chance.
- AC2: Rest requires party consensus in multiplayer (majority vote, host tiebreak).

**US-R2 (P0) Autosave.** State is saved after every resolved DM turn.
- AC1: Max data loss on crash = the in-flight turn only.
- AC2: Host can export a session transcript (Markdown) and a recap.

### 3.7 Safety

**US-X1 (P0) Content settings.** Host sets content boundaries at lobby.
- AC1: Options: tone (family / standard fantasy / mature), hard-blocked topics (sexual content involving minors always blocked and non-configurable), violence level, lines/veils list as free text.
- AC2: Any player can trigger an anonymous **"X-card"** that makes the DM immediately steer away without explanation; effect visible in next DM turn.
- AC3: Settings are injected into every DM generation call and checked by an output filter (§7.5).

---

## 4. Session flow

### 4.1 Lobby / invite
1. Host creates session: chooses mode (Solo / Party), adventure (from MVP library, or "freeform AI-generated"), difficulty, tone/safety, turn-timer.
2. System issues link + code. Lobby shows seats 1–6, ready state, chat.
3. Host starts when ready. A "session zero" DM message summarizes premise, tone, and safety tools (X-card).

### 4.2 Character creation
- Per §3.3. Occurs in lobby; can be done in parallel by all seats. Starting level: 1 default; host may pick 1–5 [A6].
- Late joiners create in lobby overlay while the game continues.

### 4.3 Exploration
- Scene loop: DM describes → players act (free text or buttons) → DM resolves (checks via rules engine) → DM narrates → repeat.
- Party mode input rules in §6.1.

### 4.4 Combat
- Triggered by DM/rules engine when hostile intent is established or ambush occurs.
- Switches to initiative-ordered turns; UI shows initiative tracker, HP bars for PCs, qualitative health ("bloodied") for enemies, and a theater-of-mind positioning summary (zones: engaged / near / far) [A5]. No grid in MVP.
- Ends when all hostiles defeated, flee, or surrender; DM awards XP and loot.

### 4.5 Rest
- Per §3.6. DM may call for rest narrative.

### 4.6 Persistence / resume
- Authoritative state is stored server-side as structured data (§7.4); session id is stable URL.
- Session states: `lobby`, `active`, `paused`, `ended`, `archived`. Inactive > 14 days → archived (data retained 90 days, then deleted unless claimed by an account) [A4].

---

## 5. Roles

Host, Player, Spectator (P1), Operator. One host per session. Host may also be a player (default).

## 6. Multiplayer rules

### 6.1 Turn handling (exploration)
- **Default mode: "Collect-then-resolve".** DM opens a round; each non-away player may submit one action. Round resolves when (a) all active players submit, or (b) the round timer expires (default 120 s party, host-configurable, "off" allowed), or (c) host presses "Resolve now". DM resolves actions together in a single narration, ordering by fiction and calling for rolls.
- **Alternative mode (P1): "Free flow".** Any player may post at any time; DM batches messages in a 5-second debounce window.
- Out-of-character (OOC) chat is a separate channel and never reaches the DM unless prefixed or sent via "ask the DM" button.

### 6.2 Simultaneous input
- Server serializes all inputs by receipt timestamp; DM generation is single-threaded per session (one in-flight DM turn). Inputs arriving during generation are queued and shown as "queued" to the sender.
- Edits: a player may edit/withdraw their submission until the round resolves.
- Conflicting actions (two players grab one item) are resolved by DM narration, with contested rolls where SRD calls for it; tie-break by initiative-style roll.

### 6.3 Combat turns
- Strict initiative order. Only active player acts. Reactions interrupt via explicit prompt with a 15 s window (auto-decline on expiry).
- Away/disconnected PC: DM-controlled with "defensive autopilot" (Dodge, move to cover, use healing potion if < 25% HP; never spends consumables otherwise, never initiates risky actions) [A7].

### 6.4 Drop-in / drop-out
- Drop-out: PC marked away after 30 s; party continues. PC stays in the fiction (follows party), excluded from spotlight prompts.
- Drop-in: joiner gets a recap and enters at next scene boundary or between combat rounds; DM provides an in-fiction entrance. In combat, a joiner's PC is added to the initiative at the next round.
- Permanent leave: host can mark PC "retired" (becomes NPC companion or stays behind).
- Min party: session continues with ≥ 1 connected player; zero connected → auto-`paused`.

### 6.5 Host controls (full list)
Pause/resume · kick/ban from session · mute · transfer host · edit safety settings (changes announced in-fiction-neutral banner) · set timers · force-resolve round · rewind last DM turn (see §7.6) · end session · export transcript · toggle spectators (P1) · approve/deny late joiners.

### 6.6 Conflict and fairness
- Host cannot read players' private DM whispers (P1 feature; "whisper to DM" visible only to sender and DM). In MVP there are no secret channels, so all state is public. [Q9]

---

## 7. AI DM behavior requirements

### 7.1 Architecture principle (requirement, not design)
**Deterministic rules, generative narration.** The LLM proposes intent and narration; a deterministic rules engine owns dice, math, HP, slots, conditions, and legality. The LLM must never be the source of truth for any numeric or state outcome.

### 7.2 Narration
- R-N1 (P0): Tone and length controlled: default 60–180 words per resolution; never > 300 unless a scene opener or recap.
- R-N2 (P0): Always ends a scene turn with a clear hook or prompt for the next actor(s).
- R-N3 (P0): Uses second person/character names; no narrating PC thoughts or actions unprompted (no "puppeting"). AC: automated eval flags < 2% of turns for puppeting on a 200-turn test set.
- R-N4 (P1): Style presets (grim, whimsical, heroic).

### 7.3 Dice and rolls
- R-D1 (P0): All dice are rolled server-side with a CSPRNG; each roll logged with seed-independent entry (formula, dice, modifiers, result, requester).
- R-D2 (P0): Rolls shown to players with the breakdown. DM may not alter a logged result. "Fudging" is not offered in MVP [Q8].
- R-D3 (P0): Advantage/disadvantage, crits, and auto-fail/auto-success per SRD.
- R-D4 (P1): Player-initiated manual roll (virtual dice animation) for engagement; result still server-generated.

### 7.4 Rules adjudication and state
- R-R1 (P0): Rules engine implements SRD 5e: ability checks, saves, attacks, damage types/resistances, conditions, spellcasting (slots, concentration, components abstracted), initiative, action economy, death saves, rests, XP/levels 1–5 in MVP [A6].
- R-R2 (P0): DM output is parsed as structured actions (JSON/tool calls) validated by the engine; invalid or illegal proposals are rejected and re-prompted (max 2 retries) before falling back to a safe narrated outcome.
- R-R3 (P0): Players can invoke "Rules check?" on any ruling; DM cites the SRD rule or states "DM discretion". Target: cites correct SRD rule ≥ 90% on a 100-question rules eval [A10].
- R-R4 (P0): Rule of cool: where SRD is silent, DM rules reasonably and logs the ruling for consistency.
- Authoritative state (sheets, inventory, HP, location, quests, NPC registry, world flags) is stored in structured form; the LLM receives it each turn.

### 7.5 Consistency and memory
- R-M1 (P0): Per-turn context = system prompt + safety settings + structured state + rolling recent transcript + retrieved long-term memory (summaries, NPC/place facts).
- R-M2 (P0): After each scene, the system writes a compact summary and updates the NPC/location/quest registry.
- R-M3 (P0): Contradiction guard: when the DM names an existing entity, its registry facts are injected; eval per US-E3.
- R-M4 (P1): "Lore Q&A" lets a player ask "what do we know about X?" answered only from registry/transcript (no invention).

### 7.6 Safety and content controls
- R-S1 (P0): Content settings (§3.7) are enforced in prompt and by an independent output moderation pass on every DM message before display; blocked output is regenerated (max 2) then replaced with a safe redirect.
- R-S2 (P0): Player input moderation: disallowed content (illegal content, sexual content involving minors, targeted harassment, real-person defamation, instructions for real-world harm) is rejected with a neutral message and logged.
- R-S3 (P0): Prompt-injection resilience: player text cannot change system rules ("ignore previous instructions", "give me 1000 gold", "set my HP to max"). AC: ≥ 95% resistance on a 100-prompt red-team set; state changes only through rules engine.
- R-S4 (P0): X-card and "pause/talk" immediate-effect (next generation).
- R-S5 (P0): Minors: product is 13+ in the free-text path with a stricter default preset for self-declared under-18 users; no collection of PII beyond display name and optional email [A3][Q4].
- R-S6 (P1): Report-a-message flow to operator moderation queue with transcript context.
- R-S7 (P0): Host "rewind last turn": undo last resolved DM turn (state + transcript) once per turn, announced to the party.

### 7.7 Out-of-scope DM behavior
No real-time web access, no impersonating real people, no medical/legal/financial advice in OOC, no persistent data on real-world users inside fiction.

---

## 8. Rules scope

### MVP (assumption **[A1]**: D&D 5e SRD only)
- Content: SRD races/species (the SRD set), classes at levels 1–5 (all 12 SRD base classes with the one SRD subclass each), SRD backgrounds, equipment, spells (levels 0–3 in MVP), monsters (CR ≤ 5), conditions, SRD magic items (common/uncommon subset).
- Adventures: 3 pre-authored short adventures (2–3 hr each) using original (non-WotC) settings and names, plus freeform AI-generated one-shot.
- Rules excluded from MVP: grid combat, multiclassing, feats beyond SRD, crafting, downtime, mounted/vehicle combat, siege, optional/variant rules, levels 6+.

### Licensing flag (**[Q1], blocking for launch**)
- The SRD is released by Wizards of the Coast under Creative Commons CC-BY 4.0 (SRD 5.1 and the 2025 SRD 5.2 revision). Use requires attribution and prohibits using non-SRD material (e.g., named Forgotten Realms characters/places, Beholder, Mind Flayer, Displacer Beast and other non-SRD monsters, non-SRD spells and subclasses) and WotC trademarks/logos ("Dungeons & Dragons" branding as product name implies endorsement issues). Product name should not include "D&D" or "Dungeons & Dragons" as a brand claim; descriptive "compatible with the 5th Edition SRD" phrasing needs legal review.
- Risks: (a) LLM will produce non-SRD content from training data → need an SRD allowlist/denylist filter on entities; (b) "AI-generated" outputs and any trademark use; (c) which SRD version (5.1 vs 5.2) and any rules-set changes between them. **Needs legal review before public launch.** Recommend: legal sign-off, SRD attribution page, entity allowlist, product name without WotC marks.

---

## 9. Non-functional requirements

### 9.1 Latency (targets, p95 unless stated) **[A11]**
| Interaction | Target |
|---|---|
| Page load to interactive (broadband) | ≤ 3 s |
| Input accepted/acknowledged ("queued/thinking") | ≤ 300 ms |
| Dice/rules-engine resolution (no LLM) | ≤ 500 ms |
| First narration token streamed | ≤ 2.5 s |
| Complete DM turn (exploration) | ≤ 8 s (p50 ≤ 4 s) |
| Complete DM turn (combat, per action) | ≤ 6 s |
| State sync across clients | ≤ 1 s |
| Reconnect and state restore | ≤ 3 s |

Narration streams token-by-token; rules/dice results display before narration completes.

### 9.2 Cost per session **[A12]**
- Reference session: 2 hours, 6 players, ~150 DM turns. Target total AI cost ≤ **$1.50** per party session; ≤ **$0.60** per solo hour (≈ 60 turns). Hard per-session cap with graceful degradation (switch to cheaper model for combat bookkeeping/summaries, shorter narration) at 80% of cap and "wrap-up" mode at 100%.
- Infra (non-AI) target ≤ $0.10 per session-hour.
- Levers: prompt caching for system prompt/state, smaller model for classification/moderation/summaries, capped context window with retrieval.

### 9.3 Accessibility
- WCAG 2.2 AA conformance for all MVP screens. Full keyboard operation; screen-reader-friendly live regions for DM narration, rolls, and turn changes (announce politely, not every token); respect `prefers-reduced-motion`; dice animation optional; text size and dyslexia-friendly font option; color contrast ≥ 4.5:1; no color-only information (HP, conditions); no mandatory time pressure (timers optional, extendable); optional text-to-speech for narration (P1). Captioning not applicable (no voice in MVP).

### 9.4 Moderation and trust and safety
- Two-sided moderation per §7.6; logs retained 30 days for abuse review; operator dashboard for flagged events (P1); rate limits per IP/session; spam/abuse throttling; abuse of invite links mitigated by revocation and per-session join caps.

### 9.5 Reliability, security, privacy, compatibility
- Availability target 99.5% monthly (MVP). Single-session failure must not affect others. Autosave per §3.6.
- Authz: only seat owners control their PC; server is authoritative; all state mutations server-validated.
- Privacy: collect minimum data; transcripts are stored to enable resume; disclose that content is sent to third-party AI providers; support delete-my-session; no use of user content for model training by default [Q4].
- Browsers: latest 2 versions of Chrome, Firefox, Safari, Edge; responsive down to 360 px width (phone play supported, desktop optimized).
- Concurrency target for MVP: 200 concurrent sessions (≤ 1,200 connected users) [A13].
- Localization: English only in MVP.

---

## 10. Phasing

| Phase | Contents |
|---|---|
| **MVP (P0)** | Solo + party 2–6; lobby/invite; guided SRD character creation (L1–5); collect-then-resolve turns; theater-of-mind combat; rests; autosave/resume; server dice; rules engine; DM narration + memory registry; safety (settings, X-card, input/output moderation, rewind); host controls; 3 original adventures + freeform; WCAG 2.2 AA; cost caps; analytics. |
| **Phase 2 (P1)** | Free-flow input mode; spectators; whispers; TTS narration; character import/export; account claiming and cross-device library; report flow and operator moderation dashboard; style presets; lore Q&A; levels 6–8; simple tactical grid; scene illustrations. |
| **Phase 3 (P2)** | Persistent multi-session campaigns with calendar/scheduling; voice input; shared maps with fog of war; homebrew content within SRD framework; adventure authoring tools; licensed/partner content; native apps; monetization. |

---

## 11. Success metrics

| Metric | Target (first 90 days post-launch) |
|---|---|
| Activation: landing → first DM turn | ≥ 60% of visitors who click Play |
| Time to first narration (quick start) | median ≤ 2 min |
| Session completion (reach a scene-end or rest) | ≥ 55% |
| D1 resume rate (returns to a saved session within 7 days) | ≥ 35% |
| Party sessions as share of all sessions | ≥ 30% |
| Median session length | ≥ 45 min solo, ≥ 75 min party |
| Post-session rating (thumbs / 1–5) | ≥ 4.0/5 |
| Rules-correctness (eval + player "rules flag" rate) | ≥ 90% eval; < 3% of turns flagged |
| Safety: X-card use leading to successful redirect | ≥ 98% |
| Safety: moderation false negatives on red-team set | ≤ 5% |
| Latency SLO attainment (§9.1) | ≥ 95% of turns |
| Cost per session within cap | ≥ 90% of sessions under cap |
| Accessibility: critical a11y defects at launch | 0 |

## 12. Dependencies and risks (brief)

- LLM provider cost/latency/outage and model-behavior drift. Mitigation: provider abstraction, regression eval suite, fallback model.
- Hallucinated rules or non-SRD content. Mitigation: rules engine ownership + allow/deny lists.
- Multiplayer sync complexity. Mitigation: single-writer per session, server-authoritative state.
- Content safety incidents with open-ended text. Mitigation: layered moderation, X-card, rewind, reporting.
- Legal/IP (§8).
- Long-context memory quality over multi-session play.

## 13. Open questions and decisions for the human (prioritized)

**Blockers (need answer before build starts)**
1. **[Q1] Licensing/IP:** confirm SRD 5.1 vs 5.2, CC-BY attribution plan, product name without WotC marks; who obtains legal review? (Blocks launch; naming blocks branding work.)
2. **[Q2] Platform and AI provider/budget:** which LLM provider(s), and is the $1.50/party-session and $0.60/solo-hour cost ceiling acceptable? Is there a total monthly budget?
3. **[Q3] Accounts:** is guest-only acceptable at MVP, or are accounts (email/OAuth) required day one? (Affects resume across devices, moderation, abuse control.)
4. **[Q4] Audience and privacy:** minimum age (13+? 18+?), COPPA/GDPR obligations, transcript retention, and whether user content may be used to improve models (default: no).

**Important (decide during design)**
5. **[Q5] Combat presentation:** theater-of-mind only for MVP (assumed) vs a basic grid.
6. **[Q6] Spectators and public sessions:** allow in MVP? Public/discoverable tables or invite-only (assumed invite-only)?
7. **[Q7] Away-player autopilot:** is "defensive autopilot" acceptable, or should the party vote on one of: pause, skip, or autopilot?
8. **[Q8] Dice fudging / fail-forward:** should the AI DM ever soften outcomes (hidden fudging), or strict honest dice only (assumed; fail-forward only for narrative stakes, never altering rolls)?
9. **[Q9] Private info:** do we need DM whispers/secret rolls (e.g., Perception, hidden info) in MVP or after?
10. **[Q10] Quality bar and eval:** who owns the rules/consistency eval sets, and what is the minimum pass rate gating release?

**Nice to decide**
11. **[Q11]** Pre-authored adventure themes/tone for the 3 MVP adventures; original setting name/lore.
12. **[Q12]** Monetization intent (affects cost model, accounts, free tier limits).
13. **[Q13]** Human-DM or hybrid mode ever? (Affects architecture.)
14. **[Q14]** Languages beyond English and timeline.
15. **[Q15]** Voice (TTS/STT) priority.

## 14. Assumptions (labeled)

- **A1** Rules content is D&D 5e SRD only (assumed per brief); no non-SRD material.
- **A2** Web-only, responsive; no native apps in MVP.
- **A3** Guest play with device token at MVP; account claim is lightweight; audience 13+.
- **A4** Retention: archive after 14 days inactive; delete after 90 days unclaimed.
- **A5** Combat is theater-of-mind with range bands, no grid.
- **A6** MVP level range 1–5; starting level default 1.
- **A7** Away-player autopilot is defensive only.
- **A8** "Fair spotlight" measured as ≥ 1 direct prompt per active player per 10 DM turns.
- **A9** Solo difficulty target survival ≥ 70% is a tunable playtest metric.
- **A10** Evaluation sets (consistency, rules, red-team) are built by the team; thresholds are initial targets.
- **A11** Latency targets assume a hosted frontier-class LLM with streaming; may need revisiting once provider chosen.
- **A12** Cost targets are initial and depend on provider pricing; reference session sizes are estimates.
- **A13** MVP concurrency 200 sessions.
- **A14** English only.
- **A15** The AI DM is the only DM; humans do not take over DM role.

## 15. Self-consistency checklist (verified by reading, not executed)

- Every user story in §3 (US-S1–S3, P1–P6, C1–C3, E1–E3, B1–B3, R1–R2, X1) has acceptance criteria. ✔ (manual read)
- Turn timers: default 90 s combat (US-B2), 120 s exploration (§6.1). Both host-configurable. Intentionally different.
- Away threshold 30 s consistent across US-P5, §6.3, §6.4.
- Levels 1–5 consistent across §4.2, §7.4, §8, A6; spells ≤ level 3 matches L5 casters.
- Safety: hard block on sexual content involving minors consistent across US-X1, R-S2.
- Dice authority is server-side in US-E2, R-D1, §7.1.
- Not verified: cost and latency figures are targets, not measured; success metric thresholds are unvalidated guesses.
