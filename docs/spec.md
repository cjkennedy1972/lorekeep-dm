# Product Requirements Spec: AI Dungeon Master (working title "Lorekeep-DM")

Status: Draft v0.4 (round-3 decisions applied) · Date: 2026-10-06 · Owner: Compass (Product & Requirements)
Scope: spec only. No implementation, no external messaging.

Conventions: **[A#]** = labeled assumption (see §14). **[Q#]** = open question (see §13; numbers are never reused, so closed questions leave gaps). Priorities: **P0** = MVP must, **P1** = Phase 2, **P2** = Phase 3 / later. **Later roadmap** = unscheduled, outside every phase (§10.1). Gaps in A#/Q# numbering are retired items; numbers are never reused.
Terms: **table** = one game session (lobby through end). **Device session** = a logged-in browser/device. **Age attestation** = the registrant's birthdate entry at registration, from which 18+ is computed; the stored result is an adult flag plus check date [A29]. **Endpoint** = the operator-configured LLM service (§7.8).

---

## Changes since v0.1

**Round 3 (v0.4, decisions log 2026-10-06 round 3) overrides the round-2 items below where they conflict:**

R3-1. **Mature content is on by default and acceptable unless any player at the table opts out.** Not explicit: innuendo and allusion are fine, subject to the configured endpoint's rules; explicit sexual content stays out of scope; the hard floor on sexual content involving minors is unchanged and non-configurable. Any one player's opt-out disables mature for the table. Players see the table's content settings at join and can opt out before play and mid-session. The host no longer needs to opt in. Per-player lines/veils and pause stay. Mature (the default) carries over on host transfer. Rewritten: §3.7 tiers, US-X1, US-X2, US-P3, US-P6, R-S1/R-S3 wording, A18, A26, A28, Q18, metrics, risks, test matrix, phasing. Q26 is closed (most-restrictive-wins confirmed).
R3-2. **Age attestation is a birthdate entry at registration** (18+ computed). Under-18 is refused and nothing is kept for them. Stored data is the adult flag plus check date, not the birthdate, unless sage's architecture says otherwise (architect to confirm and flag). US-A1, A29, R-S5, §9 privacy text updated.
R3-3. **No scope cuts.** MVP keeps all 12 SRD classes and adventures #1-#3, authored plus stretch procedural maps, local-model fallback modes; timeline about 23 weeks per architecture.md v0.3 §11. No cut-list language remains.

Round 1 and 2 decisions: Human decisions applied (authoritative). Round 1 (items 1–7) was applied in v0.2. Round 2 (decisions log, 2026-10-06 round 2) is applied in v0.3 and overrides v0.2 text; it changes items 4, 5 and 7 and adds item 8:

1. **Rules base is SRD 5.2.1** (2024 rules, CC-BY-4.0). v0.1's "5.1 vs 5.2" question is closed. "Race" wording becomes "species"; character creation follows the 5.2.1 sequence.
2. **LLM endpoint is operator-configurable** (base URL, model, key; OpenAI-compatible and Anthropic API styles; self-hosted/local allowed). Vendor-specific cost caps ($1.50/party session, $0.60/solo hour) are removed; cost is metered generically (§9.2). Latency targets are now per-endpoint baselines.
3. **Accounts are required.** Guest-only MVP is gone: registration, login, device-session management, account export and deletion are P0 (§3.0). Every seat, host and spectator is an account.
4. **Minimum age 18+** (round 2). Age attestation at registration, minimal data. Removed from MVP: the under-18 account tier, the verified-adult tier, parent-contact collection, the consent flow and its launch-blocking question, and all related status and table logic (US-A5, US-A5b, US-A6 deleted; ids not reused). A consent-based younger-audience option is one labeled item under Later roadmap (§10.1).
5. ~~Mature content: off by default, host opt-in~~ **Superseded by round 3 (R3-1):** mature is on by default unless any player opts out; per-player settings and pause stay; the non-configurable hard floor on sexual content involving minors stays.
6. **Log retention is 30 days** (§9.4, A4). Scope of "log" is an assumption [A24] and an open question [Q23].
7. **Combat is a visual tabletop**: a battle map with miniature tokens and terrain/set pieces (§3.5, §4.4). Replaces theater-of-mind/range bands (old A5) and the "no grid / no battle map" non-goal. **Round 2:** the 2D top-down grid map is the first-release view [A19]; 3D/isometric view and import of user STL/GLB minis and 3D-printed terrain are Later roadmap only (§10.1).
8. **Legal/compliance questions are deferred** to a parking-lot list (§13, Deferred legal/compliance), not milestone gates. SRD CC-BY attribution stays an MVP requirement (§8).

Derived changes: personas (miniatures hobbyist added; no under-18 personas); stories US-A1 (attestation), US-O1, US-B4–B7, US-X2 (default-on mature, any-player opt-out, personal limits, pause), US-M1; map accessibility and rendering NFRs (§9.1, §9.3); report-a-message (R-S6) raised from P1 to P0 because tables run open-ended text between strangers; "simple tactical grid" removed from Phase 2 (now MVP); "account claiming" removed from Phase 2 (accounts are day one); success metrics (map performance, mature-gate integrity); assumptions (three age-tier assumptions retired, A28 and A29 added); open questions per §13 (new Q26; closed Q2, Q3, Q5 and the two age/verification questions; legal items parked).

Downstream docs now stale (outside this file's write scope): `architecture.md` and ADRs that assume range bands/no grid, guest identity, a single LLM vendor, or $-based caps; `reuse-audit.md` §2.2 and §2.9 call a grid/battle map out of scope. Any doc that mentions the age tiers or the consent flow is also stale. Needs a follow-up pass.

---

## 1. Problem and vision

Running D&D needs a Dungeon Master, a scheduled group, and rules fluency. Many people who want to play have none of the three. Existing AI-text-adventure tools lack real rules adjudication, dice integrity, party play, and campaign continuity.

**Vision:** a browser game where 1–6 account holders open a link and play a rules-faithful (5e SRD 5.2.1) D&D session run by an AI DM that narrates, adjudicates, rolls honest dice, remembers the story, shows combat on a tabletop-style map with miniatures and terrain, and respects safety and content settings.

**Non-goals (MVP):** native mobile apps, voice/video chat, user-generated content marketplace, homebrew rules editor, fog of war / dynamic lighting, non-SRD content, human-DM mode, monetization/billing, tabletop-publisher licensed settings, **3D or isometric rendering, upload or import of any user-supplied asset (images, maps, 3D models), map editor, guest/anonymous play, users under 18, age verification, physics simulation.**

## 2. Personas

| ID | Persona | Description | Needs |
|---|---|---|---|
| P-Solo | **Sam, the solo adventurer** | Adult; wants D&D without a group; 30–90 min sessions, often at night. | Quick start, a DM that adapts, no rules homework, resume later. |
| P-Host | **Harper, the party host** | Adult; organizes a friend group (2–6), usually remote. Technically comfortable. | Easy invite, control over who joins, pacing, safety/content settings, kick/mute. |
| P-Newbie | **Nia, the first-timer** | Joins via invite link, has never played. | Guided character creation, plain-language explanations, a map that shows what is happening. |
| P-Vet | **Vic, the veteran player** | Knows 5e, distrusts AI DMs. | Correct rules, visible dice/math, correct grid movement/range, ability to challenge a ruling. |
| P-Access | **Alex, the accessibility-dependent player** | Screen reader and/or keyboard-only, or dyslexia/low vision. | Fully operable UI; the battle map must have a text and keyboard equivalent; no timing pressure. |
| P-Mini | **Mira, the miniatures hobbyist** | Owns painted minis and 3D-printed terrain; wants her table to look like her table. | Tokens that look like minis; later roadmap: use her own 3D models and printed sets (not in the first release). |
| P-Admin | **Operator** (internal) | Runs the service. | LLM endpoint configuration, usage metering and budgets, moderation queue, age-attestation records, retention jobs, observability. |

All personas are adults (18+, attested at registration).

## 3. Core user stories and acceptance criteria

Format: story, then acceptance criteria (AC). All AC are testable.

### 3.0 Accounts and age attestation

**US-A1 (P0) Register.** As a new user, I create an account.
- AC1: Registration needs email, password, display name, and a birthdate entry (age attestation); 18+ is computed from it. Under-18 registrations are refused with a neutral message and nothing is kept for them (no account, no birthdate, no flag) [A29]. Password policy: ≥ 10 characters and not on a breached-password list [A3].
- AC2: Registration is impossible without a birthdate that computes to 18+; the Terms state the 18+ minimum. For accepted users the stored record is the adult flag, check date and Terms/Privacy version, keyed to the account; the birthdate itself is not retained unless sage's architecture decides otherwise [A29], so a later age or consent flow can extend it without a schema rewrite (§10.1).
- AC3: Email verification link expires after 24 h; unverified accounts cannot host or join tables.
- AC4: Current Terms and Privacy Notice versions accepted at signup are recorded with a timestamp (with the attestation, AC2).
- AC5: Registration and login endpoints are rate-limited per IP and per email; responses never reveal whether an email is already registered.
- AC6: Display names pass the input moderation filter (§7.6 R-S2).

**US-A2 (P0) Login, logout, password reset.**
- AC1: Email+password login; failed attempts are throttled (≥ 5 failures in 10 min → exponential delay); error text is identical for unknown email and wrong password.
- AC2: Password reset by emailed single-use link (expires in 1 h); a successful reset revokes all other device sessions.
- AC3: Logout ends the current device session server-side (token invalid immediately).

**US-A3 (P0) Manage device sessions.**
- AC1: Account page lists active device sessions (device/browser label, last active time) and lets me revoke any one or "sign out everywhere"; revocation takes effect within 60 s.
- AC2: Idle device sessions expire after 30 days of inactivity (sliding), absolute lifetime 90 days [A3].
- AC3: Changing the password or email requires re-entering the current password.

**US-A4 (P0) Export and delete my account.**
- AC1: "Export my data" produces a downloadable archive (JSON: profile, characters, game-state snapshots, summaries; Markdown: transcripts still within retention) within 24 h of request.
- AC2: "Delete my account" requires re-authentication and a typed confirmation. Effect is immediate for the user (login disabled, profile hidden); all personal data is purged from live stores within 30 days and from backups on their normal ≤ 30-day cycle [A25].
- AC3: In tables I don't own, my PC becomes a DM-controlled NPC with my display name and chat lines redacted from the transcript. Tables I host transfer host to a connected player; if none is connected the table is archived and its remaining owner-less data purged on the 30-day schedule.
- AC4: A deletion request cannot be undone after the confirmation step; the confirmation screen says so.

### 3.1 Solo

**US-S1 (P0) Start a solo game fast.** As Sam, I start a solo adventure.
- AC1: A signed-in user goes from landing page to first DM narration in ≤ 3 minutes including "quick start" character creation. A new user including registration and email verification: median ≤ 5 minutes.
- AC2: Solo tables belong to my account and are visible in "My games" on any device [A3].
- AC3: Solo mode never blocks waiting on other players.

**US-S2 (P0) Solo is balanced for one.** As Sam, encounters are tuned for a single character (optionally with 1–2 DM-controlled companion NPCs).
- AC1: Encounter generator takes party size/level as input and uses SRD 5.2.1 encounter-building guidance (verify what 5.2.1 provides; any gap is filled with documented original tuning, not DMG tables); solo default difficulty "moderate" targets ≥ 70% character survival over a 10-encounter playtest set [A9].
- AC2: Player can toggle companion NPC on/off at lobby.

**US-S3 (P0) Resume.** As Sam, I return days later and continue.
- AC1: Opening my game from "My games" restores character sheet, inventory, HP, location, battle-map state if mid-combat, quest log, and a "Previously on…" recap (≤ 150 words) before first new narration. The recap is built from stored summaries and the registry, not from raw transcripts that may have aged out (§9.4).
- AC2: Resume works after browser close, device change (log in), and server redeploy.

### 3.2 Party (2–6)

**US-P1 (P0) Create and invite.** As Harper, I create a party table and share an invite link.
- AC1: Creating a table yields a join URL and 6-char code in ≤ 2 clicks.
- AC2: Link supports 1–6 seats; 7th joiner sees "party full" and an option to spectate if host enables it [Q6].
- AC3: Host can revoke/regenerate link; old link stops working immediately.

**US-P2 (P0) Join with a signed-in account.** As Nia, I join through a link on any modern browser.
- AC1: Opening the link while signed out sends me to login/register and then back to the link. No anonymous join. The pre-login page shows only the table name, not members or settings.
- AC2: A `suspended` account cannot join (neutral message).
- AC3: Joiner lands in lobby showing party (display names), host, and safety settings summary including whether mature content is on (§3.7).

**US-P3 (P0) Everyone plays a character.** As any player, I create or import my own character.
- AC1: Each seat has exactly one active PC (see §4.2).
- AC2: Lobby shows per-seat readiness; host can start only when ≥ 1 PC is ready, with warning for unready seats.

**US-P4 (P0) Shared scene, fair spotlight.** As a player, I get meaningful agency in a group.
- AC1: DM addresses players by character name and, in any 6-player scene lasting ≥ 10 DM turns, each non-idle player receives ≥ 1 direct prompt [A8].
- AC2: Per-player action queue is visible; I can see who has/hasn't submitted.

**US-P5 (P0) Drop in/out.** As a player, I can disconnect/rejoin without breaking the table.
- AC1: Disconnect > 30 s flags the PC "away" and the DM auto-runs it per §6.3; rejoin restores control within 2 s of reconnect.
- AC2: A new player can join mid-session at a safe point (§6.4), subject to the mature-content rule (US-X2: a late joiner sees the table settings and can opt out first).

**US-P6 (P0) Host controls.** As Harper, I can manage the table.
- AC1: Host can pause/resume, kick, mute a player, transfer host, end the table, change safety settings (§3.7), and set turn-timer mode.
- AC2: Kicked player cannot rejoin with the same link without host re-invite.
- AC3: If host disconnects > 2 min, host role auto-transfers to the longest-connected player (configurable off); the table's mature setting carries over unchanged to the new host (US-X2).

### 3.3 Character

**US-C1 (P0) Guided creation.** As Nia, I build a legal SRD 5.2.1 character step by step.
- AC1: Flow follows the SRD 5.2.1 creation sequence (class, background with its ability-score increases, species, ability scores by standard array / point buy / rolled, equipment, name/personality; verify order against the 5.2.1 text). Every choice has a one-line plain-language explanation.
- AC2: Validation: sheet cannot be saved if it violates SRD rules (e.g., point-buy cap, invalid proficiencies).
- AC3: "Quick build" produces a legal, level-1 pre-built PC in ≤ 2 clicks.
- AC4: Character name, personality text and backstory pass input moderation (§7.6 R-S2).

**US-C2 (P0) Live sheet.** As any player, I see my sheet update as the game proceeds.
- AC1: HP, conditions, slots, inventory, and XP/level changes reflect within 1 s of the authoritative event.
- AC2: Level-up flow triggers at SRD XP thresholds (or DM milestone) and enforces legality.

**US-C3 (P1) Import/export.** Export character as JSON; import a previously exported SRD-legal character.
- AC1: Round-trip export→import yields identical sheet; illegal imports are rejected with specific error messages.

### 3.4 Exploration and roleplay

**US-E1 (P0) Free-text actions.** As a player, I describe what I do in natural language.
- AC1: DM responds to a valid action within the latency targets (§9.1).
- AC2: If an action is ambiguous, DM asks one clarifying question rather than guessing, at most once per action.
- AC3: Player can also use quick-action buttons (Look, Talk, Search, Move, Use item, Cast).

**US-E2 (P0) Skill checks that feel fair.** As Vic, I see how rolls are decided.
- AC1: DM calls for a check with ability/skill and DC reasoning shown on request ("why DC 15?").
- AC2: Roll result, modifiers, and outcome are displayed; roll is performed by server RNG, never the LLM (§7.3).

**US-E3 (P1) Persistent world.** As a player, NPCs and places stay consistent.
- AC1: In a 3-session regression script, named NPCs retain name, role, disposition, and key facts with ≥ 95% consistency as judged by an automated fact-check set [A10].

### 3.5 Combat on the battle map

**US-B1 (P0) Structured combat.** As a player, combat follows SRD 5.2.1 initiative and action economy.
- AC1: Initiative rolled by server for all combatants; order displayed.
- AC2: Each turn offers action, bonus action, movement, reaction; used resources (including remaining movement in feet) are tracked.
- AC3: Attack rolls, damage, saves, and conditions applied per SRD by rules engine; DM narrates results.

**US-B2 (P0) Simultaneous-turn handling.** (See §6.2.) In party combat, only the active combatant's inputs are accepted for their turn, except reactions and out-of-character chat.
- AC1: Non-active player attempting an action receives "not your turn" and, if relevant, a reaction prompt when one triggers.
- AC2: Turn timer (default off for solo, 90 s default for party, configurable) auto-"Dodge/hold" on expiry.

**US-B3 (P0) Death and unconsciousness.** Dropping to 0 HP triggers SRD death saves; solo TPK offers retry-from-checkpoint or "narrative fail-forward" (host/solo choice).
- AC1: Death saves rolled by server; 3 successes stabilize, 3 failures kill, per SRD.
- AC2: Any PC death produces a recorded event and an offered resurrection/new-character path.

**US-B4 (P0) See the battle.** As any player, when combat starts I see a top-down grid map with miniature tokens and terrain/set pieces.
- AC1: Combat start shows a map (square grid, 1 square = 5 ft) with one token per combatant (PC, ally, enemy) labeled with name and a non-color team marker, plus terrain/set pieces from the first-party catalog (walls, doors, difficult terrain, pits, water, furniture, trees, pillars) [A19].
- AC2: Token HP display follows existing rules: exact for PCs, qualitative ("bloodied") for enemies; conditions shown as icons with text labels.
- AC3: The active combatant is highlighted; the initiative tracker and the map agree at all times (a test asserts the highlighted token equals the first entry in the tracker).
- AC4: Map state (positions, terrain, tokens) syncs to all clients ≤ 1 s after the authoritative event (§9.1).
- AC5: Map scale is fixed at the SRD 5-ft square; map size up to 50 × 50 squares and ≤ 40 tokens in MVP [A21].

**US-B5 (P0) Move my token.** As the active player, I move my token and the rules engine enforces the rules.
- AC1: I can move by pointer (drag or click destination), by keyboard (US-B6), or by describing it ("move next to the barrel"); the DM proposes a destination, the engine pathfinds, and I confirm a preview showing path and cost in feet before it is committed.
- AC2: The engine rejects moves that exceed remaining speed, end in an occupied square, pass through walls/closed doors, or violate conditions (e.g., prone, grappled); rejection shows the specific reason.
- AC3: Difficult terrain costs double movement; diagonal movement uses the SRD 5.2.1 rule.
- AC4: Leaving an enemy's reach triggers an opportunity-attack reaction prompt (15 s window) via the engine, never via LLM discretion.
- AC5: The LLM can never place or move a token directly; it proposes intents that the engine validates (§7.1).

**US-B6 (P0) Map without a mouse or sight.** As Alex, I can play combat entirely through keyboard and text.
- AC1: The map is a single focusable region; arrow keys move a cursor/token one square (5 ft) with the running path cost announced; Enter confirms, Esc cancels; keys cycle targets/creatures ([ and ]) and jump to "nearest enemy" and "my token".
- AC2: A "Describe battlefield" command (button and key) outputs text such as "You are at C4. Goblin 2 is 15 ft northeast behind a barrel (half cover). Ally Brin is 10 ft west." with distances in feet and clock/compass directions; the same text is exposed as a screen-reader live region at the start of my turn (remaining movement, threats within 30 ft).
- AC3: A "Tokens and terrain" list view offers every token and set piece with coordinates, distance from me, and state, sortable by distance.
- AC4: Every pointer drag has a non-drag equivalent (WCAG 2.2 criterion 2.5.7).
- AC5: Automated check: the full combat flow of the quick-start adventure completes in a keyboard-only test and a screen-reader (live region) script without pointer input.

**US-B7 (P0) Ranges, cover, and areas.** As Vic, the engine computes geometry correctly.
- AC1: Melee reach, ranged-attack range bands (including disadvantage beyond normal range), and spell range are computed in feet from grid positions.
- AC2: Cover (half/three-quarters/total) is computed from a line between squares and terrain/set-piece cover values; the attack roll display shows "cover: half (+2 AC)" when applied.
- AC3: Area-of-effect spells show a template preview and list affected creatures before commit; the list is computed by the engine.
- AC4: A 100-case geometry test suite (movement cost, reach, range, cover, AoE) passes at 100%; this is a release gate [A10].

### 3.6 Rest and persistence

**US-R1 (P0) Short and long rests.** As a player, I take rests per SRD.
- AC1: Short rest allows hit-dice spending; long rest restores HP/slots/hit dice per SRD; DM can inject rest interruptions (random encounter) with a configurable chance.
- AC2: Rest requires party consensus in multiplayer (majority vote, host tiebreak).

**US-R2 (P0) Autosave.** State is saved after every resolved DM turn.
- AC1: Max data loss on crash = the in-flight turn only; map state is part of the saved state.
- AC2: Host can export a session transcript (Markdown) of the retained window (§9.4) and a recap.

### 3.7 Safety and content

Content tiers: **Family** (no graphic violence, no romance beyond hints), **Standard fantasy** (SRD-style combat violence, non-graphic) and **Mature** (**default**; not explicit, innuendo and allusion allowed subject to the endpoint's rules; scope in A18, [Q18]). Mature is the starting tier for every new table unless any player at the table opts out (US-X2); the host may also pick a lower tier.

**US-X1 (P0) Content settings.** Host sets content boundaries at lobby.
- AC1: Options: tone (Mature default / Standard fantasy / Family; Mature is capped by any player's opt-out per US-X2), hard-blocked topics (sexual content involving minors always blocked and non-configurable), violence level within the tier, lines/veils list as free text.
- AC2: Any player can trigger an anonymous **"X-card"** that makes the DM immediately steer away without explanation; effect visible in next DM turn.
- AC3: Settings are injected into every DM generation call and checked by an output filter (§7.6) that does not depend on the DM model.

**US-X2 (P0) Mature content: default on, any-player opt-out, personal limits, pause.** As any player, I see the table's content settings before I play and can opt out; as Harper, I need no opt-in.
- AC1: **Default is Mature (on, not explicit)** for every new table; the host does not opt in. Explicit sexual content is out of scope in every tier; innuendo and allusion are allowed, subject to the configured endpoint's rules.
- AC2: **Effective mature = table default on ∧ no seated player or spectator has "mature: not for me" set** [A28]. Any one opt-out disables mature for the whole table (shared scene). Evaluated server-side at lobby start, on every join/reconnect and on every change. The effective value is what is injected into DM calls and the output filter.
- AC3: **Disclosure and opt-out at join:** the invite page and lobby show the table content settings (tier, "Mature content: on/off", lines/veils, X-card/pause) before anyone joins; joining needs a one-click acknowledgment with the "mature: not for me" switch on the same screen, so a player can opt out before play. Personal settings are never shown to other players by name; the table sees a neutral banner when effective mature changes.
- AC4: **Per-player settings:** each player has personal lines/veils (free text, enforced as blocked topics for the whole table, union across players) and the "mature: not for me" switch, changeable at any time including mid-session; effect from the next DM turn.
- AC5: **Pause:** any participant can pause the table at any time (button and key) without explanation; generation stops after the in-flight turn, and the table resumes when the pausing player or the host resumes. Complements the X-card (US-X1 AC2); both take effect next generation (R-S4).
- AC6: If effective mature becomes false mid-game (a player opts out), content drops to the highest non-mature tier on the next DM turn and a neutral banner is shown.
- AC7: Audit test: across a generated matrix of ≥ 200 combinations (opt-outs before play and mid-session, personal settings, joins, host transfers (mature carries over), spectators, reconnects), the effective flag equals the AC2 formula and a mature-tier probe prompt is never sent when the formula is false. Zero violations is a release gate.
- AC8: The hard floor (sexual content involving minors) holds in every tier, including Mature, and cannot be configured, toggled or bypassed by prompt text.

### 3.8 Operator

**US-O1 (P0) Configure the LLM endpoint.** As the operator, I point the product at any compatible model service.
- AC1: Settings accept base URL, model name, API key, and API style (OpenAI-compatible or Anthropic); optional second "light model" slot for summaries/classification; optional separate moderation endpoint (§7.6). Self-hosted/local URLs are allowed.
- AC2: On save, a connection test checks reachability, streaming, tool/function calling, and context-window size, and reports pass/fail per capability. The save is allowed with warnings but the console marks an endpoint as "not qualified" until it passes the rules/consistency eval suite (§11) at the release threshold.
- AC3: The API key is write-only in the UI after saving, is stored encrypted at rest, and never appears in client responses, logs or transcripts.
- AC4: Only the operator role can edit endpoint settings (players and hosts cannot supply URLs); a change takes effect for new DM turns without data loss; an in-flight turn finishes on the old setting.
- AC5: Usage metering and budgets are viewable per table and in aggregate (§9.2).

### 3.9 Map content

**US-M1 (P0) Maps come from a first-party catalog.** As a player, I get believable maps without uploading anything.
- AC1: Each pre-authored adventure ships with its encounter maps as structured data (grid, terrain/set-piece objects with IDs, starting positions) [A19].
- AC2: For freeform encounters the DM selects a map template and terrain/set pieces by catalog ID; the engine validates that spawn positions are legal and the map is traversable between the party and enemies. Free-form image maps are not used in MVP [Q21].
- AC3: Every map object and token art asset is first-party, public-domain/CC0, or licensed with the license recorded in an asset manifest; a release check fails if an asset lacks a license entry.

Later-roadmap map items are listed in §10.1; none are in the first release.

---

## 4. Session flow

### 4.1 Lobby / invite
1. Host (signed in) creates a table: chooses mode (Solo / Party), adventure (from MVP library, or "freeform AI-generated"), difficulty, tone/safety (§3.7), turn-timer.
2. System issues link + code. Lobby shows seats 1–6, ready state, chat, and the mature-content on/off label.
3. Host starts when ready. A "session zero" DM message summarizes premise, tone, and safety tools (X-card).

### 4.2 Character creation
- Per §3.3. Occurs in lobby; can be done in parallel by all seats. Starting level: 1 default; host may pick 1–5 [A6].
- Late joiners create in lobby overlay while the game continues.

### 4.3 Exploration
- Scene loop: DM describes → players act (free text or buttons) → DM resolves (checks via rules engine) → DM narrates → repeat.
- Party mode input rules in §6.1. In MVP exploration is narrative with no map; scene maps in exploration are P1.

### 4.4 Combat
- Triggered by DM/rules engine when hostile intent is established or ambush occurs.
- Switches to initiative-ordered turns on the battle map (§3.5): initiative tracker, token HP display (exact for PCs, qualitative for enemies), terrain/set pieces, movement and range in feet on a 5-ft grid [A5].
- The engine owns positions, movement, range, cover and areas; the DM narrates outcomes and proposes intents only.
- Ends when all hostiles defeated, flee, or surrender; DM awards XP and loot; map is dismissed and a text summary of the final positions is kept in the transcript.

### 4.5 Rest
- Per §3.6. DM may call for rest narrative.

### 4.6 Persistence / resume
- Authoritative state (including map state during combat) is stored server-side as structured data (§7.4); the table id is a stable URL that requires a signed-in participant.
- Table states: `lobby`, `active`, `paused`, `ended`, `archived`. Inactive > 14 days → archived. Archived and ended tables stay in the owner's "My games" until the owner deletes them or the account is deleted [A4]. Raw transcripts and operational logs follow the 30-day rule (§9.4).

---

## 5. Roles

Host, Player, Spectator (P1), Operator. One host per table. Host may also be a player (default). Every Host, Player and Spectator is an authenticated, adult-attested account in good standing (`active`).

## 6. Multiplayer rules

### 6.1 Turn handling (exploration)
- **Default mode: "Collect-then-resolve".** DM opens a round; each non-away player may submit one action. Round resolves when (a) all active players submit, or (b) the round timer expires (default 120 s party, host-configurable, "off" allowed), or (c) host presses "Resolve now". DM resolves actions together in a single narration, ordering by fiction and calling for rolls.
- **Alternative mode (P1): "Free flow".** Any player may post at any time; DM batches messages in a 5-second debounce window.
- Out-of-character (OOC) chat is a separate channel and never reaches the DM unless prefixed or sent via "ask the DM" button. OOC chat is moderated like input (§7.6).

### 6.2 Simultaneous input
- Server serializes all inputs by receipt timestamp; DM generation is single-threaded per table (one in-flight DM turn). Inputs arriving during generation are queued and shown as "queued" to the sender.
- Edits: a player may edit/withdraw their submission until the round resolves.
- Conflicting actions (two players grab one item) are resolved by DM narration, with contested rolls where SRD calls for it; tie-break by initiative-style roll.
- Map moves in combat are only accepted from the active combatant and are applied by the engine in the order received.

### 6.3 Combat turns
- Strict initiative order. Only active player acts and moves their token. Reactions (including opportunity attacks) interrupt via explicit prompt with a 15 s window (auto-decline on expiry).
- Away/disconnected PC: DM-controlled with "defensive autopilot" (Dodge, move to cover on the map within its speed, use healing potion if < 25% HP; never spends consumables otherwise, never initiates risky actions or moves into hazards) [A7].

### 6.4 Drop-in / drop-out
- Drop-out: PC marked away after 30 s; party continues. PC stays in the fiction (follows party; its token stays on the map), excluded from spotlight prompts.
- Drop-in: joiner gets a recap and enters at next scene boundary or between combat rounds; DM provides an in-fiction entrance. In combat, a joiner's PC is added to the initiative at the next round and its token is placed by the engine at a legal entry square.
- Permanent leave: host can mark PC "retired" (becomes NPC companion or stays behind).
- Min party: table continues with ≥ 1 connected player; zero connected → auto-`paused`.

### 6.5 Host controls (full list)
Pause/resume · kick/ban from table · mute · transfer host · edit safety settings (changes announced in-fiction-neutral banner; Mature applies unless any player opts out, per US-X2) · set timers · force-resolve round · rewind last DM turn (see §7.6) · end table · export transcript · toggle spectators (P1) · approve/deny late joiners.

### 6.6 Conflict and fairness
- Host cannot read players' private DM whispers (P1 feature; "whisper to DM" visible only to sender and DM). In MVP there are no secret channels, so all table state is public. [Q9]

---

## 7. AI DM behavior requirements

### 7.1 Architecture principle (requirement, not design)
**Deterministic rules, generative narration.** The LLM proposes intent and narration; a deterministic rules engine owns dice, math, HP, slots, conditions, legality, **and map geometry (positions, movement, range, cover, areas)**. The LLM must never be the source of truth for any numeric, positional, or state outcome.

### 7.2 Narration
- R-N1 (P0): Tone and length controlled: default 60–180 words per resolution; never > 300 unless a scene opener or recap.
- R-N2 (P0): Always ends a scene turn with a clear hook or prompt for the next actor(s).
- R-N3 (P0): Uses second person/character names; no narrating PC thoughts or actions unprompted (no "puppeting"). AC: automated eval flags < 2% of turns for puppeting on a 200-turn test set.
- R-N4 (P1): Style presets (grim, whimsical, heroic).
- R-N5 (P0): Combat narration references positions only as reported by the engine (no invented distances or "he is now behind you" contradicting the map); automated check on a 100-turn combat set flags < 2% contradictions.

### 7.3 Dice and rolls
- R-D1 (P0): All dice are rolled server-side with a CSPRNG; each roll logged with seed-independent entry (formula, dice, modifiers, result, requester).
- R-D2 (P0): Rolls shown to players with the breakdown. DM may not alter a logged result. "Fudging" is not offered in MVP [Q8].
- R-D3 (P0): Advantage/disadvantage, crits, and auto-fail/auto-success per SRD.
- R-D4 (P1): Player-initiated manual roll (virtual dice animation) for engagement; result still server-generated.

### 7.4 Rules adjudication and state
- R-R1 (P0): Rules engine implements SRD 5.2.1: ability checks, saves, attacks, damage types/resistances, conditions, spellcasting (slots, concentration, components abstracted), initiative, action economy, **grid movement, opportunity attacks, cover, ranges and areas of effect**, death saves, rests, weapon mastery and other 5.2.1 core mechanics, XP/levels 1–5 in MVP [A6].
- R-R2 (P0): DM output is parsed as structured actions (JSON/tool calls) validated by the engine; invalid or illegal proposals are rejected and re-prompted (max 2 retries) before falling back to a safe narrated outcome with no state change.
- R-R3 (P0): Players can invoke "Rules check?" on any ruling; DM cites the SRD rule or states "DM discretion". Target: cites correct SRD rule ≥ 90% on a 100-question rules eval [A10].
- R-R4 (P0): Rule of cool: where SRD is silent, DM rules reasonably and logs the ruling for consistency.
- Authoritative state (sheets, inventory, HP, location, **map and token positions**, quests, NPC registry, world flags) is stored in structured form; the LLM receives it each turn.

### 7.5 Consistency and memory
- R-M1 (P0): Per-turn context = system prompt + safety settings + structured state + rolling recent transcript + retrieved long-term memory (summaries, NPC/place facts).
- R-M2 (P0): After each scene, the system writes a compact summary and updates the NPC/location/quest registry. Summaries and the registry are game state, not logs, so they outlive the 30-day log window [A24].
- R-M3 (P0): Contradiction guard: when the DM names an existing entity, its registry facts are injected; eval per US-E3.
- Registry memory is per game/session and stores only validated game facts for NPCs, locations, quests, flags, and rulings. Updates retain superseded versions; facts are append/supersede-only. Postgres full-text and trigram retrieval is bounded and never crosses game boundaries. Registry and summaries are game state, not 30-day logs (§9.4).
- R-M4 (P1): "Lore Q&A" lets a player ask "what do we know about X?" answered only from registry and retained transcript (no invention).

### 7.6 Safety and content controls
- R-S1 (P0): Content settings (§3.7) are enforced in prompt and by an **independent output moderation pass on every DM message before display**. The pass must not rely on the DM model's own safety behavior, because configured and self-hosted models may have none; it uses a separately configured moderation endpoint or a built-in classifier [Q24]. Blocked output is regenerated (max 2) then replaced with a safe redirect.
- R-S2 (P0): Player input moderation (chat, actions, character text, display names): disallowed content (illegal content, sexual content involving minors, targeted harassment, real-person defamation, instructions for real-world harm) is rejected with a neutral message and logged.
- R-S3 (P0): Prompt-injection resilience: player text cannot change system rules ("ignore previous instructions", "give me 1000 gold", "set my HP to max", "move my token to the exit", "enable mature content"). AC: ≥ 95% resistance on a 100-prompt red-team set; state changes only through rules engine; the effective content tier cannot be changed by any text.
- R-S4 (P0): X-card and "pause/talk" immediate-effect (next generation).
- R-S5 (P0): Adults only: birthdate entry at registration with 18+ computed (US-A1); under-18 refused, nothing kept. The product collects no PII beyond email, display name and the adult flag with check date (the birthdate is entered but not stored unless architecture decides otherwise). Self-declared; verification is not in MVP [A29].
- R-S6 (P0, was P1): Report-a-message flow available to every participant from day one; reports (with transcript context) go to an operator review queue. The review dashboard UI is P1; in MVP the queue may be a basic list.
- R-S7 (P0): Host "rewind last turn": undo last resolved DM turn (state, map and transcript) once per turn, announced to the party.
- R-S8 (P0): The hard floor (sexual content involving minors) is enforced in the product's moderation layer regardless of tone tier or model, and fails closed: if moderation is unavailable, DM output is held, not shown.

### 7.7 Out-of-scope DM behavior
No real-time web access, no impersonating real people, no medical/legal/financial advice in OOC, no persistent data on real-world users inside fiction.

### 7.8 LLM endpoint (operator-configured)
- R-L1 (P0): The product talks to one operator-configured endpoint: base URL, model, API key, API style (OpenAI-compatible or Anthropic). No code path may assume a particular vendor, model family, or pricing. Self-hosted/local models are supported.
- R-L2 (P0): The endpoint must support streaming and tool/function calling and a context window of at least 32k tokens [A22]; the connection test (US-O1) verifies this. Where tool calling is unsupported the product refuses to mark the endpoint qualified rather than silently falling back.
- R-L3 (P0): Prompt-caching or other vendor features are used opportunistically when the endpoint advertises them and never required for correctness.
- R-L4 (P0): Quality varies by model, so the same eval suites (rules, consistency, puppeting, red-team, geometry contradiction) run against whichever endpoint is configured; results are shown to the operator and a qualification threshold applies (§11).
- R-L5 (P0): Player content is sent only to the configured endpoint (and moderation endpoint if separate). The privacy notice names the operator's configured endpoint class (hosted third party vs self-hosted) and the operator is responsible for that provider's terms (e.g., acceptable-use rules for mature content) [Q24].

---

## 8. Rules scope

### MVP (assumption **[A1]**: D&D 5e **SRD 5.2.1** only)
- Content: the SRD 5.2.1 species, classes at levels 1–5 (all 12 SRD 5.2.1 base classes, none cut, with the one SRD subclass each), SRD 5.2.1 backgrounds, equipment, spells (levels 0–3 in MVP), monsters (CR ≤ 5), conditions, SRD magic items (common/uncommon subset). Exact counts are to be read from the 5.2.1 text, not from this spec.
- Adventures: 3 pre-authored short adventures (2–3 hr each) using original (non-WotC) settings and names, each with structured encounter maps (US-M1), plus freeform AI-generated one-shot using catalog maps.
- Rules excluded from MVP: multiclassing, feats beyond SRD, crafting, downtime, mounted/vehicle combat, siege, optional/variant rules, levels 6+, fog of war and dynamic lighting, flying/3D vertical positioning (elevation is abstracted).

### Licensing (**SRD CC-BY attribution is an MVP requirement**; legal review is deferred, see §13)
- SRD 5.2.1 (published 2025-05-01) is licensed by Wizards of the Coast under CC-BY-4.0. Use requires the exact attribution statement: "This work includes material from the System Reference Document 5.2.1 ("SRD 5.2.1") by Wizards of the Coast LLC, available at https://www.dndbeyond.com/srd. The SRD 5.2.1 is licensed under the Creative Commons Attribution 4.0 International License, available at https://creativecommons.org/licenses/by/4.0/legalcode." No other attribution to Wizards is requested. **MVP requirement:** the statement is shown on an About/Legal page linked from the footer of every screen; a release check fails if it is missing. The statement "compatible with fifth edition" / "5E compatible" is permitted. Source: research brief, from a mirror of the official legal text; the official PDF was not read.
- Non-SRD material is not covered (e.g., Beholder, Mind Flayer, Forgotten Realms names, non-SRD spells and subclasses). D&D branding must not be used as the product name or to imply endorsement (inferred; confirm with counsel).
- Risks: (a) LLM will produce non-SRD content from training data (and a self-hosted model more so) → SRD allowlist/denylist filter on entities; (b) trademarks. The mini/terrain catalog must not depict non-SRD protected creatures. Legal review of these points is parked in §13 (Deferred legal/compliance); the attribution statement ships in the MVP regardless.

---

## 9. Non-functional requirements

### 9.1 Performance and latency (targets, p95 unless stated) **[A11, A21, A23]**
LLM-dependent targets are baselines for a streaming hosted endpoint; the operator console records the measured baseline per configured endpoint and flags misses. Self-hosted models may need relaxed targets, set by the operator.

| Interaction | Target |
|---|---|
| Page load to interactive (broadband) | ≤ 3 s |
| Input accepted/acknowledged ("queued/thinking") | ≤ 300 ms |
| Dice/rules-engine resolution (no LLM), including movement/geometry validation | ≤ 500 ms |
| First narration token streamed | ≤ 2.5 s (reference endpoint) |
| Complete DM turn (exploration) | ≤ 8 s (p50 ≤ 4 s) (reference endpoint) |
| Complete DM turn (combat, per action) | ≤ 6 s (reference endpoint) |
| State sync across clients, including token moves | ≤ 1 s |
| Reconnect and state restore | ≤ 3 s |

Narration streams token-by-token; rules/dice results display before narration completes.

**Map rendering (MVP, 2D):**
| Metric | Target |
|---|---|
| Frame rate while panning/zooming/animating tokens, 50 × 50 map, 40 tokens, 200 terrain objects | ≥ 60 fps on a reference mid-tier laptop (integrated GPU, ~2020); ≥ 30 fps on a reference mid-range phone (~2022, ~4 GB RAM) |
| Local feedback for a pointer or key move (cursor/token ghost) | ≤ 100 ms |
| Map first paint after combat start (assets cached / cold) | ≤ 1 s / ≤ 3 s |
| Map asset payload per encounter | ≤ 3 MB total (cold) |
| Client memory attributable to map view | ≤ 300 MB on the reference phone |
| Degradation | If frame rate stays < 24 fps for 5 s the client drops animations and effects automatically and offers a "low graphics" setting; text and keyboard alternatives are unaffected |

**Later roadmap, 3D/isometric view [A20]:** ≥ 30 fps on the reference laptop and ≥ 24 fps on a reference phone; feature-detected with automatic 2D fallback. **Later roadmap, user-supplied models:** upload ≤ 25 MB; imported model decimated to ≤ 100k triangles; scene ≤ 1M triangles; validation and decimation ≤ 30 s server-side.

### 9.2 Usage metering and budgets (vendor-neutral) **[A12, A22]**
- Every endpoint call is metered: purpose (narration, summary, classification, moderation), model id, input/output/cached tokens where reported (estimated otherwise), latency, retries, errors. Metering works for any endpoint, including self-hosted ones.
- Per table and aggregate usage are visible to the operator. The operator may optionally enter unit prices per million input/output/cached tokens to see cost estimates; with no prices set (e.g., self-hosted) the console shows tokens only.
- Optional operator-set per-table budget in tokens (or in currency when prices are set). At 80% the DM degrades gracefully (lighter model slot for bookkeeping/summaries, shorter narration); at 100% the table enters "wrap-up" mode (finish the scene, save, stop new DM turns). With no budget set there is no cap and only metering.
- Reference token profile for planning (not a cap): average ≤ 12k input tokens (of which a stable prefix of ≥ 6k is cache-eligible where supported) and ≤ 700 output tokens per DM turn, ≤ 2 model calls per turn, one summary call per ~20 turns. Derived from the research brief's assumptions; to be re-measured.
- Infra (non-AI) target ≤ $0.10 per table-hour at 200 concurrent tables, stated in currency because infra is not vendor-dependent.
- Levers: stable prompt prefix, smaller model slot for classification/summaries, capped context with retrieval, low tool round trips.

### 9.3 Accessibility
- WCAG 2.2 AA conformance for all MVP screens, **including the battle map**. Full keyboard operation; screen-reader-friendly live regions for DM narration, rolls, and turn changes (announce politely, not every token); respect `prefers-reduced-motion` (no token or dice animation); dice animation optional; text size and dyslexia-friendly font option; no color-only information (HP, conditions, team, terrain).
- **Map alternatives (see US-B6):** keyboard-only movement and targeting; on-demand and turn-start text description of the battlefield (positions in feet and directions, cover, hazards); list view of tokens and terrain; no drag-only operations (2.5.7); target size ≥ 24 × 24 CSS px for map controls (2.5.8).
- **Map visuals:** graphical contrast ≥ 3:1 for tokens, grid lines, selection and focus indicators (1.4.11); text contrast ≥ 4.5:1; zoom to 400% without loss of function; every token and set piece has an accessible name and description; team and condition are conveyed by shape/icon plus text, not color alone; a colorblind-safe palette option.
- No mandatory time pressure (timers optional, extendable); optional text-to-speech for narration (P1). Captioning not applicable (no voice in MVP).
- Account pages meet the same standard; the registration and attestation text is plain-language (target ≤ grade 8 reading level).

### 9.4 Moderation, trust and safety, and retention
- Two-sided moderation per §7.6; rate limits per IP/account/table; spam/abuse throttling; abuse of invite links mitigated by revocation and per-table join caps.
- **Retention (30 days) [A4, A24]:** operational and safety logs are deleted 30 days after creation. This covers server/application logs, moderation decisions and flagged-content snapshots, raw LLM request/response logs (prompts, completions), table chat and raw transcripts, and auth/security event logs. Deletion is automated and verified by a daily job; purge lag ≤ 24 h beyond day 30.
- **Not logs, so not purged by that rule:** account record and profile; characters and game-state snapshots; scene summaries and the NPC/location/quest registry; age-attestation records (kept while the account exists); aggregate metrics with no personal data. Whether these should also be bounded is open **[Q23]**.
- Legal holds or mandatory reports may require retaining specific items beyond 30 days; handling is parked in §13 (Deferred legal/compliance).
- Operator dashboard for flagged events and the review queue (P1).

### 9.5 Reliability, security, privacy, compatibility
- Availability target 99.5% monthly (MVP). Single-table failure must not affect others. Autosave per §3.6.
- Authz: only seat owners control their PC and token; server is authoritative; all state mutations server-validated; every request is bound to an authenticated account in an allowed state (`active`); mature opt-out and personal limits are evaluated server-side only.
- Account security: passwords hashed with a modern adaptive algorithm; email verification; login throttling; device-session revocation; MFA and OAuth are P1 [Q25].
- Privacy: collect minimum data (email, display name, adult flag plus check date; the birthdate is used to compute the flag and is not retained unless architecture decides otherwise; nothing is kept for refused under-18 registrants); transcripts and chat are stored to enable play and expire per §9.4; disclose that content is sent to the operator-configured AI endpoint and which class it is (R-L5); the product does not itself use player content for model training and the operator is responsible for the configured provider's data terms; support export and delete (US-A4); privacy notice drafted for launch; counsel review and privacy-law specifics are parked in §13 (Deferred legal/compliance).
- Browsers: latest 2 versions of Chrome, Firefox, Safari, Edge; responsive down to 360 px width (phone play supported incl. the 2D map; desktop optimized).
- Concurrency target for MVP: 200 concurrent tables (≤ 1,200 connected users) [A13].
- Localization: English only in MVP.

---

## 10. Phasing

| Phase | Contents |
|---|---|
| **MVP (P0)** | Accounts (register, login, device sessions, export, deletion); birthdate-based 18+ check at registration; mature content default-on (not explicit) with any-player opt-out, per-player limits and pause; all 12 SRD classes; SRD attribution page; operator LLM endpoint configuration and generic metering; solo + party 2–6 with invites; guided SRD 5.2.1 character creation (L1–5); collect-then-resolve turns; **2D top-down battle map with miniature tokens and first-party terrain/set-piece catalog; engine-owned movement, range, cover, areas;** keyboard/text map alternatives; rests; autosave/resume; server dice; rules engine; DM narration + memory registry; safety (settings, X-card, independent input/output moderation, report-a-message, rewind); host controls; 3 original adventures with structured maps + freeform using catalog maps; WCAG 2.2 AA; 30-day log retention job; analytics. |
| **Phase 2 (P1)** | exploration scene maps; MFA/OAuth; free-flow input mode; spectators (subject to the mature gate); whispers; TTS narration; character import/export; operator moderation dashboard; style presets; lore Q&A; levels 6–8; scene illustrations (pre-generated, license-checked). |
| **Phase 3 (P2)** | persistent multi-session campaigns with calendar/scheduling; voice input; fog of war / dynamic lighting; homebrew content within SRD framework; adventure authoring tools; licensed/partner content; native apps; monetization. |
| **Later roadmap** (unscheduled) | Listed in §10.1: 3D/isometric view; import of user STL/GLB models; custom token and map upload/editor; consent-based younger-audience option. |

### 10.1 Later roadmap

Nothing here is in the MVP or dated. Each item needs its own spec pass, and the related deferred questions in §13 answered first.

- **L1 3D/isometric view** (was US-M2). Toggle the same combat between 2D top-down and 3D/isometric views of one authoritative state; rules and keyboard/text alternatives (US-B6) identical in both; first-party stock models; automatic 2D fallback if WebGL2 is missing or performance misses §9.1.
- **L2 User-supplied minis and printed sets** (was US-M3). Upload STL/GLB: validated and sandboxed server-side (format, ≤ 25 MB, triangle budget with auto-decimation, no external references); scale normalized (1-inch base = one 5-ft square); private to the uploader's tables, moderated before others see them, reportable and removable; uploader attests rights. Gated on Q19, Q20.
- **L3 Custom token image upload; custom map upload/editor.** Gated on Q19, Q20, Q21.
- **L4 Parental consent and a 13-17 audience.** Not in MVP. The only MVP hook is the stored adult-flag record (US-A1 AC2); a later spec would decide whether to retain birthdates. A later spec would cover: lowering the minimum age, a verifiable consent mechanism, guardian revoke/delete/export, minor-safe table rules (locked non-mature, strictest moderation) and re-consent. Prerequisites: counsel review and a choice of consent mechanism. No minor-specific states, tables or data fields are built now.

---

## 11. Success metrics

| Metric | Target (first 90 days post-launch) |
|---|---|
| Activation: landing → first DM turn | ≥ 40% of visitors who click Play (account wall expected to lower this vs. v0.1's 60%) |
| Registration funnel: started → verified email | ≥ 70% |
| Time to first narration (quick start) | median ≤ 2 min signed-in; ≤ 5 min new account |
| Session completion (reach a scene-end or rest) | ≥ 55% |
| D7 resume rate (returns to a saved game within 7 days) | ≥ 35% |
| Party tables as share of all tables | ≥ 30% |
| Median session length | ≥ 45 min solo, ≥ 75 min party |
| Post-session rating (thumbs / 1–5) | ≥ 4.0/5 |
| Rules-correctness (eval + player "rules flag" rate) | ≥ 90% eval; < 3% of turns flagged |
| Map geometry: engine test suite pass rate (US-B7) / "map or position wrong" player flags | 100% / < 2% of combat turns |
| Combat completed through keyboard-only/text path in the a11y test script | 100% pass at each release |
| Map frame-rate attainment on reference devices (§9.1) | ≥ 95% of combat sessions meet target (client-reported p50 fps) |
| Safety: X-card use leading to successful redirect | ≥ 98% |
| Safety: moderation false negatives on red-team set | ≤ 5% (hard-floor category: 0 on the red-team set) |
| Mature-gate integrity: tables with effective mature on while any participant's "not for me" is set | **0** (audit job over all tables) |
| Retention compliance: items older than 30 days + 24 h in log stores | 0 (daily check) |
| Latency SLO attainment (§9.1, against the configured endpoint's baseline) | ≥ 95% of turns |
| Metering coverage: DM turns with a recorded usage entry | ≥ 99%; share of tables under the operator budget (when set) ≥ 90% |
| Endpoint qualification: configured endpoint passes the rules/consistency/red-team eval thresholds before production use | required |
| Accessibility: critical a11y defects at launch | 0 |

## 12. Dependencies and risks (brief)

- LLM endpoint cost/latency/outage and model-behavior drift; large quality spread across configurable models. Mitigation: endpoint abstraction, per-endpoint qualification evals, fallback endpoint/slot, metering.
- Self-hosted or permissive models may emit unsafe content. Mitigation: independent moderation pass that fails closed (R-S1, R-S8), hard floor in product code.
- Underage users despite the 18+ attestation (self-declared; no verification in MVP). Mitigation: birthdate check at registration, Terms state 18+, minimal data, report-a-message (R-S6), hard floor in product code, removal on discovery; verification options are parked in §13.
- Mature-content setting errors (race on join, stale personal setting) and default-on exposure (a player misses the disclosure). Mitigation: settings shown at join before play, one-click opt-out, server-side evaluation on every join/transfer, matrix test as release gate (US-X2 AC7).
- Hallucinated rules or non-SRD content. Mitigation: rules engine ownership + allow/deny lists.
- Map/engine complexity (pathfinding, cover, AoE) and client rendering performance on phones. Mitigation: bounded map size, geometry test suite, low-graphics fallback.
- Later roadmap: user-uploaded 3D models carry IP, malware (file parsing), and abusive-content risks; see §13 Deferred legal/compliance (Q19, Q20) before scheduling.
- Multiplayer sync complexity. Mitigation: single-writer per table, server-authoritative state.
- Content safety incidents with open-ended text. Mitigation: layered moderation, X-card, rewind, reporting.
- Legal/IP and privacy: parked in §13 (Deferred legal/compliance); not a milestone gate.
- Long-context memory quality over multi-session play, now that raw transcripts expire after 30 days: memory must live in summaries/registry (R-M2).

## 13. Open questions and decisions for the human (prioritized)

Closed in round 3: Q26 (any player's opt-out disables mature for the table, confirmed), and the host-opt-in/host-transfer-reset questions (mature is default-on and carries over). Closed since v0.1: Q2 (provider/budget → configurable endpoint, generic metering), Q3 (accounts → required), Q5 (combat → battle map). Closed in round 2: the age/consent question (minimum age 18+; consent-based younger audience is Later roadmap L4), the adult-verification question (no verification tier), and the 3D/own-model timing question (both are Later roadmap, §10.1). Narrowed: Q1 (SRD version decided; attribution is an MVP requirement; legal review and naming parked), Q4 (min age and retention decided), Q21 (first release is 2D, no uploads), Q23 (design scope only; legal holds parked).

**Blockers (need answer before build starts)**
1. **[Q24] Moderation classifier:** which classifier (separate configured endpoint vs built-in) provides the independent moderation pass (R-S1, R-S8). The fail-closed requirement is fixed; the choice is open.

**Important (decide during design)**
2. **[Q6] Spectators and public sessions:** allow in MVP? Public/discoverable tables or invite-only (assumed invite-only)? Spectators' personal settings apply to the mature rule [A26].
3. **[Q7] Away-player autopilot:** is "defensive autopilot" acceptable, or should the party vote on one of: pause, skip, or autopilot?
4. **[Q8] Dice fudging / fail-forward:** should the AI DM ever soften outcomes (hidden fudging), or strict honest dice only (assumed; fail-forward only for narrative stakes, never altering rolls)?
5. **[Q9] Private info:** do we need DM whispers/secret rolls (e.g., Perception, hidden info) in MVP or after?
6. **[Q10] Quality bar and eval:** who owns the rules/consistency/geometry eval sets, and what is the minimum pass rate that qualifies an endpoint for production?
7. **[Q18] Scope of "mature":** decided round 3: default on, not explicit; innuendo/allusion allowed subject to the endpoint's rules; explicit sexual content out of scope [A18]. Remaining: exact wording of the DM-facing tier prompt and endpoint-rule handling.
8. **[Q21] Map authoring and source of maps:** assumed first-party structured maps and catalog templates picked by the DM, no uploads and no AI-generated images in MVP [A19]. Alternatives: AI-generated map images (needs a vision step to derive walls/cover, plus model licensing), procedural dungeon generator, user-drawn maps (Later roadmap). Who creates the art and set-piece catalog, and under what license?
9. **[Q23] Retention scope:** does 30 days cover only operational/safety logs and raw transcripts (assumed [A24]) or also game state and summaries?

**Nice to decide**
11. **[Q11]** Pre-authored adventure themes/tone for the 3 MVP adventures; original setting name/lore.
12. **[Q12]** Monetization intent (affects accounts, free tier limits, and payment rules).
13. **[Q13]** Human-DM or hybrid mode ever? (Affects architecture.)
14. **[Q14]** Languages beyond English and timeline.
15. **[Q15]** Voice (TTS/STT) priority.
16. **[Q25]** Sign-in methods: email+password only at MVP (assumed) or OAuth/passkeys/MFA at launch; whether email verification must precede first play.

### Deferred legal/compliance (parking lot)

Not launch blockers and not milestone gates (human decision, round 2). Revisit when the project shows it is viable. The one exception is SRD CC-BY attribution, which ships in the MVP (§8).

- Legal review of SRD use, the non-SRD denylist, and the product name/trademark (no WotC marks) [Q1].
- Privacy-law specifics by jurisdiction; whether self-attested 18+ is sufficient where we launch; EU/UK availability; Terms and privacy notice review.
- Consent-based younger audience: see L4 (§10.1).
- Uploaded-asset IP (only once uploads exist, L2/L3): content license, DMCA/takedown posture, personal-use-only or pirated STL files, trademarked likenesses [Q19].
- Upload moderation: review approach for images and 3D models, hash matching, takedown SLA, file-parser sandboxing [Q20].
- Retention legal basis: legal holds, mandatory child-safety reports, retention of attestation records [Q23].
- Provider terms: who answers for the configured endpoint's acceptable-use rules when mature content is on or the model is self-hosted [Q24].

## 14. Assumptions (labeled)

- **A1** Rules content is D&D 5e **SRD 5.2.1** only (human decision); no non-SRD material.
- **A2** Web-only, responsive; no native apps in MVP.
- **A3** Accounts are required for all participants (human decision). MVP sign-in is email + password with verified email; passwords ≥ 10 characters and breach-checked; device sessions idle out after 30 days, absolute 90 days. Minimum age 18 with attestation at registration (human decision, round 2).
- **A4** Retention: operational and safety logs, raw LLM logs, chat and raw transcripts are deleted 30 days after creation (human decision on 30 days; scope per A24). Tables archive after 14 days inactive and stay in the owner's library until deleted by the owner or with the account. Account deletion completes within 30 days (A25).
- **A5** Combat is on a visual battle map: square grid, 1 square = 5 ft, miniature tokens, terrain/set pieces, engine-owned geometry (human decision; replaces theater-of-mind).
- **A6** MVP level range 1–5; starting level default 1.
- **A7** Away-player autopilot is defensive only.
- **A8** "Fair spotlight" measured as ≥ 1 direct prompt per active player per 10 DM turns.
- **A9** Solo difficulty target survival ≥ 70% is a tunable playtest metric.
- **A10** Evaluation sets (consistency, rules, red-team, geometry) are built by the team; thresholds are initial targets.
- **A11** Latency targets assume a streaming endpoint comparable to a hosted frontier-class model; each configured endpoint gets a measured baseline.
- **A12** Reference token profile (§9.2) is an initial estimate, not a cap; cost estimates exist only if the operator enters unit prices.
- **A13** MVP concurrency 200 tables.
- **A14** English only.
- **A15** The AI DM is the only DM; humans do not take over the DM role.
- **A18** *(round 3)* "Mature" is the default tier: graphic violence/gore, horror, dark themes, strong language, and non-explicit romantic or sexual themes (innuendo and allusion), subject to the configured endpoint's rules; explicit sexual content is out of scope. The hard floor on sexual content involving minors applies in every tier. Open: Q18.
- **A19** *(new)* MVP maps are structured data (grid + catalog objects), authored first-party or picked from catalog templates; MVP tokens and terrain are first-party/CC0 2D assets with a license manifest; no user uploads and no AI-generated map images in MVP. Open: Q21.
- **A20** *(new)* The first release is 2D top-down only. 3D/isometric view and import of user-supplied STL/GLB and 3D-printed set models are Later roadmap (§10.1), gated on the deferred legal and moderation questions.
- **A21** *(new)* MVP map limits: ≤ 50 × 50 squares, ≤ 40 tokens, ≤ 200 terrain objects; elevation abstracted.
- **A22** *(new)* A usable endpoint supports streaming, tool/function calling and ≥ 32k tokens of context.
- **A23** *(new)* Reference devices: a ~2020 laptop with integrated GPU and a ~2022 mid-range phone with ~4 GB RAM.
- **A24** *(new)* "Logs" (30-day rule) = server/app logs, moderation records, raw LLM request/response logs, chat and raw transcripts, auth/security events. Game state, summaries, registry, account and age-attestation records are not logs. Open: Q23.
- **A25** *(new)* Account deletion: immediate lock-out; purge from live stores ≤ 30 days; backups purge on a ≤ 30-day cycle; PCs in others' tables become anonymized NPCs; owned tables transfer host or archive.
- **A26** *(new)* Spectators count as participants for the mature content rule (US-X2): their opt-out disables mature for the table, and they see the table settings at join.
- **A28** *(new, round 2)* Personal limits apply table-wide because the scene is shared and the DM narrates once: lines/veils are unioned, and any player's "mature: not for me" lowers the effective tier (most restrictive wins; confirmed round 3, Q26 closed). Mature is default-on with no host opt-in and carries over on host transfer.
- **A29** *(new, round 2)* Self-declared birthdate at registration is sufficient for the MVP: 18+ is computed, under-18 is refused with nothing kept, and no verification is performed. Stored: adult flag plus check date, unless sage's architecture says otherwise (to confirm and flag).

## 15. Self-consistency checklist (verified by reading and by grep, not executed)

- Every user story in §3 (US-A1–A4, S1–S3, P1–P6, C1–C3, E1–E3, B1–B7, R1–R2, X1–X2, O1, M1) has acceptance criteria. ✔ (manual read)
- Turn timers: default 90 s combat (US-B2), 120 s exploration (§6.1). Both host-configurable. Intentionally different.
- Away threshold 30 s consistent across US-P5, §6.3, §6.4.
- Levels 1–5 consistent across §4.2, §7.4, §8, A6; spells ≤ level 3 matches L5 casters.
- Safety: hard floor on sexual content involving minors consistent across US-X1, US-X2 AC8, R-S2, R-S8, A18.
- Dice authority is server-side in US-E2, R-D1, §7.1; map geometry authority is engine-side in US-B5, US-B7, §7.1, R-R1, R-N5.
- Round-3 grep (off by default, opt-in, opts in, host transfer, checkbox, attestation) leaves only superseded-note, birthdate-attestation and carry-over hits. Mature rule is stated once (US-X2 AC2) and referenced from US-P6 AC3, §6.5, A26, A28.
- Retention: 30 days stated in §9.4 and A4/A24; resume and recap rely on summaries and registry (US-S3, R-M2, R-M4), not raw transcripts.
- Round-2 grep for the retired age/consent/verification terms and ids: the only remaining hits are L4 (§10.1, Later roadmap). Earlier stale-term grep (guest, theater-of-mind, range band, Anthropic, $1.50, $0.60, no grid, SRD 5.1) still holds: hits are the change log, non-goals, the Anthropic API-style option, and "ranged-attack range bands" in US-B7. Not verified: cost, latency, fps and success-metric thresholds are targets, not measurements; SRD 5.2.1 specifics (counts, encounter guidance, diagonal rule, creation order) must be read from the 5.2.1 text; legal statements are not legal advice.
