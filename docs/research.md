# Research brief: web-based AI Dungeon Master (1–6 players)

Compiled 2026-10-06 by Scout. Research only; no code. Sources fetched 2026-10-06 unless noted.
Legend: **[V]** verified by reading the primary source; **[S]** from a search summary or secondary/vendor source, not independently confirmed; **[?]** uncertain / my inference.

---

## 1. D&D 5e SRD licensing

**Findings**
- Two SRDs exist, both under **CC-BY-4.0**: SRD 5.1 (2014 rules; originally OGL 1.0a + CC) and SRD 5.2 / **5.2.1** (2024 "5.5e" rules). 5.2 was published 2025-04-22; **5.2.1 on 2025-05-01**. The D&D Beyond SRD page was last updated 2026-03-02. [V] https://www.dndbeyond.com/srd
- Wizards states all future SRDs will be CC-BY-4.0 only, that a published CC-BY-4.0 document cannot be revoked, and that each version stays available under its own license. [V] same page.
- Commercial use is allowed, including crowdfunding and ongoing-support platforms, provided attribution rules are followed. SRD 5.1 FAQ: content can be used "in any creative expressions, like TTRPGs and VTTs". [V] same page. A software game that adjudicates SRD rules fits "VTT/TTRPG" use. Whether *AI generation of text based on SRD* is covered is not addressed explicitly, but CC-BY-4.0 has no use-type restriction. [?]
- Wizards says anything you create using the SRDs is yours; they don't own your derived content. [V] https://www.dndbeyond.com/creator-faq
- **Required attribution (SRD 5.2.1)**, verbatim from the SRD legal text (mirrored at https://rules.omnisgm.com/en/dnd/srd-5.2/legal/ [V mirror; the official PDF is https://media.dndbeyond.com/compendium-images/srd/5.2/SRD_CC_v5.2.1.pdf, not read by me]):
  > This work includes material from the System Reference Document 5.2.1 ("SRD 5.2.1") by Wizards of the Coast LLC, available at https://www.dndbeyond.com/srd. The SRD 5.2.1 is licensed under the Creative Commons Attribution 4.0 International License, available at https://creativecommons.org/licenses/by/4.0/legalcode.
  - "Please do not include any other attribution to Wizards or its parent or affiliates." You *may* state the work is "compatible with fifth edition" or "5E compatible." [V mirror]
  - SRD 5.1 has its own preamble attribution (same shape, "System Reference Document 5.1"). Friends & Fables, for example, publishes the 5.1 form plus "We are not affiliated with Dungeons & Dragons or Wizards of The Coast." [V] https://fables.gg/blog/why-ai-dungeon-is-not-the-ai-dungeon-master-youre-looking-for
- **What is NOT included / not allowed to use freely.** The SRD omits much IP: e.g. Artificer class, Aasimar species, Beholder; names like Strahd, Orcus, Tiamat are absent; some items renamed (Deck of Many Things → "Mysterious Deck", Orb of Dragonkind → "Dragon Orb"). Forgotten Realms content is only via DMsGuild, not CC. [V] https://www.dndbeyond.com/srd
- **D&D Beyond Basic Rules are NOT CC** and "cannot be used in content creation"; only the SRD can. [V] https://www.dndbeyond.com/creator-faq
- Fan-content (streaming, fan art etc.) is under the separate Fan Content Policy, not CC. [V] SRD page; policy itself at https://company.wizards.com/en/legal/fancontentpolicy (not read).
- 5.1 vs 5.2: 5.2 is 5.5e wording/mechanics; compatibility between them is the creator's responsibility. 5.2 dropped Half-Elf/Half-Orc and added Goliath/Orc species, weapon masteries, etc. [V] SRD page. A conversion guide exists: https://media.dndbeyond.com/compendium-images/srd/guide/converting-to-srd-5.2.1.pdf

**Trademark guidance (practical)**
- Don't use "Dungeons & Dragons"/"D&D" as the product name or imply endorsement; use "5E compatible" statement only. [V for the permitted phrase; the "don't use D&D in name" point is my inference from the "no other attribution" clause — confirm with counsel] [?]
- LLM risk: the model will happily emit non-SRD names (beholders, mind flayers, Forgotten Realms places). Restrict the monster/spell/item catalog to SRD entries and use original setting/names. [? design inference]
- Not legal advice; have counsel review before launch.

---

## 2. Existing AI DM products and projects

| Product | What it is | Strengths | Weaknesses / gaps | Source |
|---|---|---|---|---|
| **AI Dungeon** (Latitude) | Freeform generative story game; multiplayer via host-created game + 8-digit join code, no fixed participant cap | Maximum improvisational freedom; Story Cards / Plot Components for memory; real multiplayer | No enforced D&D 5e engine; memory is summarization/context-based so long campaigns drift; 2021 moderation fiasco (see §6) | [S/V partial] https://tableforge.gg/blog/multiplayer-ai-dungeon-master-comparison (vendor-written, competitor; fetched, 2026-08-14 data) ; https://help.aidungeon.com/faq/openai-and-filters [V] |
| **Friends & Fables** (fables.gg) | AI GM "Franz"; party up to 6; tactical 5e-inspired combat on battlemaps, quests, lore, travel, maps, TTS, image gen; 100,000+ players claimed | Structured state (quests, health, inventory, spells, lore); VTT integrated with narration; world-building tools; live or async | "Agentic" referee: LLM operates game tools and holds a lot of adjudication authority [S — per a competitor's description]; "5e-inspired" not strict 5e | https://fables.gg/ [V]; characterization from competitor blog above [S] |
| **TableForge** | Competitor product; up to 6 players; claims programmatic SRD rules systems have final authority, AI does interpretation + narration | Clear articulation of the "engine decides, AI narrates" architecture | Vendor marketing page; claims unverified; limited to supported SRD content, no open homebrew builder (per its own text) | https://tableforge.gg/blog/multiplayer-ai-dungeon-master-comparison [S] |
| **Roll20 / Foundry VTT** | Human-GM virtual tabletops with 5e automation | Mature sheets, dice, maps | Not AI GMs; useful as UX reference | same comparison page [S] |
| **Mortyl/ai-dungeon-master** (OSS) | Claude tool-use DM over a deterministic Python engine (FastAPI, Pydantic state, seeded dice) with an eval harness | Exactly the "LLM narrates, engine owns rules/dice/state" pattern; deterministic evals + LLM judge for prose | Small hobby-scale repo, not full 5e [?] | https://github.com/Mortyl/ai-dungeon-master [V] |
| Other OSS (not inspected beyond search listing) | `timoncool/dungeon-ultimate` (local/offline), `ShauryaKumar09/Dungeons-and-Dragons-Game-Master-` (LangGraph+Ollama, RAG rules), `ITMO-Agentic-AI/ai-dungeon-master`, `deckofdmthings/GameMasterAI`, `NeverEndingQuest` | Idea sources | Quality/maintenance unknown | via search; see https://github.com/topics/ai-game-master [S] |

**Community sentiment:** PC Gamer ran a piece on generative AI dividing RPG fans (page body failed to load for me; only headline confirmed) — expect some audience hostility to AI in tabletop; plan messaging accordingly. https://www.pcgamer.com/software/ai/generative-ai-is-dividing-rpg-fans-can-ai-really-play-dungeons-and-dragons-and-should-it/ [headline only] [?]

**Note on source quality:** most "best AI DM 2026" listicles surfaced by search are vendor blogs (TableForge, Fables, etc.) with commercial bias; treat comparative claims as [S].

---

## 3. Technical patterns for LLM game masters

1. **Function calling for dice + state is the best-evidenced pattern.** Song, Zhu, Callison-Burch (UPenn), "You Have Thirteen Hours in Which to Solve the Labyrinth: Enhancing AI Game Masters with Function Calling," Wordplay Workshop @ ACL 2024 (arXiv 2024-09-11). The model is given game-specific functions (dice roll, state update); human evals and unit tests show improved narrative quality and state-update consistency vs. prompting-only. [V abstract; details on exact functions/effect size from the search summary, not read in full] https://arxiv.org/abs/2409.06949
2. **Engine owns truth; LLM proposes.** Mortyl repo: LLM can only propose structured tool calls; the engine validates legality, applies them, rolls seeded dice, and returns ground truth that the model must narrate. Illegal actions are refused by the engine and narrated as refusals. [V] https://github.com/Mortyl/ai-dungeon-master
3. **Deterministic, auditable dice.** Roll server-side with a seeded/logged CSPRNG; store seed + roll log per session so combat is replayable and testable (same repo: "Seeded dice — combat is reproducible, which is what makes the evals possible" [V]). Never let the model "roll" in prose. For fairness among players, show roll details in the UI.
4. **Structured game state as source of truth** (characters, HP/AC/slots/conditions, inventory, quests, NPC relationships, location, initiative). Pass a compact state snapshot into each prompt; apply only validated deltas (JSON-schema tool args). Friends & Fables and TableForge both advertise this class of state [S].
5. **Memory tiers** [? design synthesis, supported partly by product descriptions]: (a) always-in-context: state snapshot + current scene; (b) rolling summary of recent turns; (c) retrieval of relevant lore/NPC/past-event notes (Friends & Fables describes a filtered "working context" feeding only scene-relevant lore [S]); (d) append-only event log from which summaries can be rebuilt. AI Dungeon's Story Cards/Memory Bank are the freeform analogue [S].
6. **Hallucination control:** closed catalogs (SRD monsters/spells/items by ID) the model must reference by ID; tool-call validation with error feedback to the model; post-hoc check that narration doesn't contradict tool results (e.g. LLM-judge or rule checks); evals that separate deterministic assertions (state/rules/tools) from LLM-judged prose quality (Mortyl repo [V]).
7. **Rules text retrieval:** put SRD in a retrieval index (one ShauryaKumar09 project uses a RAG rules expert [S]) or, better, encode core mechanics in code and let the model only look up edge-case text. [? preference]
8. **Prompt caching:** keep the long static prefix (system prompt, rules, tool definitions) stable and first so it is cache-read at ~0.1× price (Anthropic pricing, §5). [V]
9. **Multi-player specifics** [? inference]: explicit turn/initiative model; per-player "intent" queue; DM prompts must tag who said/did what; protect against one player hijacking narrative (e.g. "the DM now gives me 1000 gold") by treating player text as intent only, never as state.

---

## 4. Real-time multiplayer stack options (1–6 players)

Load is tiny (≤6 sockets per room, human-speed turns, bursty LLM streaming). Almost any option works; the real design question is *where authoritative state lives* and *how to stream LLM tokens to all players*.

| Option | Fit | Notes / source |
|---|---|---|
| **Cloudflare Durable Objects (+ PartyKit, now Cloudflare-owned)** | One single-threaded stateful object per game room = natural authoritative room; WebSocket Hibernation API lets idle rooms sleep while clients stay connected (no duration charge while hibernating); persisted state via storage + `serializeAttachment` | [V] https://developers.cloudflare.com/durable-objects/best-practices/websockets/ (updated 2026-09-30); PartyKit built on DO and acquired by Cloudflare [S] https://blog.cloudflare.com/cloudflare-acquires-partykit/ . Caveat: LLM calls from within a DO fine, but vendor lock-in; pricing not verified [?] |
| **Colyseus** (Node room-based game server) | Room/state-sync abstractions built for games | Not verified in this research — general knowledge only [?] |
| **Socket.IO / plain `ws` on a Node server + Postgres/SQLite (+ Redis if >1 node)** | Simple, portable; you write authority logic yourself. A single process easily handles hundreds of 6-player rooms | General knowledge, not sourced [?] |
| **SSE for token streaming + HTTP POST for actions** | Simplest transport for one-directional LLM streaming; WebSocket needed only if you want presence/typing/etc. | General knowledge [?] |

**Turn handling patterns** [? design]: server-authoritative room state machine (`lobby → exploration → combat(initiative) → downtime`); a "turn lock" so only one DM generation runs per room at a time; collect player intents over a short window (or in initiative order during combat) before calling the LLM; idempotent action IDs; persist an append-only event log + periodic snapshot so a reconnecting client or restarted server can rebuild state; stream narration tokens to all clients over the same channel; support async play (turns across days) since F&F and TableForge both advertise live + async [S].

---

## 5. Rough LLM cost per 3-hour session

**Prices** (Anthropic API, $ per million tokens; page fetched 2026-10-06) [V] https://platform.claude.com/docs/en/about-claude/pricing.md

| Model | Input | 5-min cache write | Cache read | Output |
|---|---|---|---|---|
| Haiku 4.5 | $1 | $1.25 | $0.10 | $5 |
| Sonnet 5.5 | $2 | $2.50 | $0.20 | $10 |
| Opus 5.5 | $4 | $5 | $0.20 | $20 |

(Sonnet 5's $2/$10 intro price became permanent; the earlier planned $3/$15 rise did not occur [V]. Claude 4.7+ models use a tokenizer producing ~30% more tokens for the same text [V] — my token counts below are in model tokens.)

**Assumptions [? mine — not measured]:** 120 DM turns in 3 h (~90 s/turn, party of any size); each turn = 2 model calls (tool-call call + narration call after tool results); static cached prefix 6k tokens read on each call; 4k uncached dynamic context (state snapshot, retrieved memory, recent messages) per call, +1k tool results on the second; output 550 tokens/turn (≈400 narration + 150 tool-call JSON); one summarization call per 20 turns (10k in, 1k out); cache stays warm because turns are <5 min apart; excluded: TTS, image generation, moderation calls, infrastructure.

**Arithmetic per turn** (cache reads 12k; uncached input 9k; output 0.55k):
- Haiku 4.5: 12k×$0.10 + 9k×$1 + 0.55k×$5 = $0.0012 + $0.0090 + $0.0028 ≈ **$0.013** → ×120 = $1.56 + summaries ≈ **~$1.7**
- Sonnet 5.5: 0.0024 + 0.0180 + 0.0055 ≈ **$0.026** → ×120 = $3.1 + summaries ≈ **~$3.3**
- Opus 5.5: 0.0024 + 0.0360 + 0.0110 ≈ **$0.049** → ×120 = $5.9 + summaries ≈ **~$6.3**

**Range:** ~$1–$10 per 3-hour session depending on model and context size; at 4 players that is roughly $0.40–$1.60 per player on Sonnet-class pricing. Biggest levers: uncached dynamic context size (retrieval discipline), number of tool-loop round trips, and model tier. Sensitivity: doubling dynamic context to 8k adds ≈ $3 on Sonnet. A hybrid (cheap model for routine narration/summaries, stronger model for key scenes) is plausible [?]. Prices change; re-check before launch.

---

## 6. Content safety and moderation

- **Precedent: AI Dungeon 2021.** Players were publishing stories depicting sexual exploitation of children; OpenAI (exclusive provider) changed its policy; Latitude rushed a filter with many false positives, erroneous algorithmic bans, and manual review of private stories (privacy backlash), ended Aug 2021; unsafe data was also found in the fine-tune and base model, so the AI generated unsafe content users got banned for. [V, first-party admission] https://help.aidungeon.com/faq/openai-and-filters (full page truncated in my fetch; independent coverage: Vice/Wired/Polygon/Techdirt listed in search, not read [S]).
  - Lessons: design moderation *before* launch; avoid human reading of private stories by default; avoid punishing players for model-generated content; communicate clearly.
- **Provider policy applies to you.** Anthropic's Usage Policy applies to anyone who can submit inputs through your product, including resellers, and has sections for consumer-facing chatbots, products serving minors, and agentic use; violations can lead to throttling/suspension. [V] https://www.anthropic.com/legal/aup (only first ~1/3 read). Prohibition on sexual content involving minors, with no fictional/roleplay exception, is reported by search summary [S — verify in the full AUP text before relying on it]. Other providers have comparable rules; OpenAI's moderation API is a common pre/post filter [? not verified here].
- **Group-play specifics [? design inference]:** with up to 6 humans, the DM must handle disagreement on content comfort: provide session-0 settings (violence/gore/romance/horror level, lines & veils), a visible "pause/skip this" control for any player, host-controlled intensity ceiling, and a hard floor that no setting can override (no sexual content involving minors, etc.).
- **Layered approach [? design]:** input classification on player text, system-prompt policy, output classification on narration before broadcast (stream with a small buffer or moderate by sentence), reporting button, rate limits, account/age gating (if minors may play, additional legal duties — COPPA/GDPR-K — not researched here), prompt-injection handling (player text must not be able to alter rules/state or reveal the system prompt).
- **Privacy:** session logs contain player-written text; decide retention, access policy, and whether data goes to model providers' training (check provider data-use terms; not researched).

---

## 7. Implications for design

1. **Build on SRD 5.2.1 (5.5e) via CC-BY-4.0**, ship the exact attribution text in the app footer/credits, say "5E compatible" at most, never use D&D branding, and don't claim endorsement. Keep a closed SRD-only catalog; use original setting names. Get a legal review. (§1)
2. **Rules engine in code, LLM as narrator/interpreter.** Server owns dice (seeded, logged), HP/AC/slots/conditions, inventory, initiative; the model proposes via validated tool calls and must narrate engine results. This is the best-supported anti-hallucination pattern. (§3)
3. **Structured state + tiered memory:** state snapshot always in prompt, rolling summaries, retrieved lore/NPC notes, append-only event log for rebuilds. Treat player text as intent, never state. (§3)
4. **Evals from day one:** deterministic assertions for state/rules/tool use + LLM judge for prose, as in the Mortyl repo. (§3)
5. **Server-authoritative room per game** (Durable Objects/PartyKit if comfortable with Cloudflare; otherwise Node + WebSocket/SSE + Postgres). One in-flight DM generation per room; stream tokens to all; event log + snapshots for reconnect. Plan for async play. (§4)
6. **Budget ~ $2–$6 per 3-hour session** on Haiku/Sonnet/Opus-class models with prompt caching; stable cached prefix, tight dynamic context, minimal tool round trips; consider model tiering. Re-verify prices at build time. (§5)
7. **Safety is a launch requirement:** layered input/output moderation, table-wide content settings + per-player pause, hard floors, no default human reading of private sessions, provider-AUP compliance, age policy decision. (§6)
8. **Differentiate vs F&F / AI Dungeon / TableForge:** strict SRD fidelity with transparent dice and state, genuine multiplayer fairness (turn/intent handling), and low per-session cost; the crowded space is vendor-blog-heavy, so claims should be backed by demos/evals. (§2)

## Open questions / not verified
- Official SRD 5.2.1 PDF text and CC-BY-4.0 legal code not read directly (attribution text taken from a mirror that matches D&D Beyond's description).
- Wizards Fan Content Policy and any explicit rule on using "D&D" in a product name not read.
- Colyseus/Socket.IO claims, Durable Objects pricing, OpenAI moderation API: unsourced.
- Competitor feature claims largely vendor-sourced; PC Gamer article body not retrieved.
- Anthropic AUP minors section only via search summary; COPPA/GDPR-K and provider data-retention terms unresearched.
- Cost model is an estimate from stated assumptions, not a measurement.
