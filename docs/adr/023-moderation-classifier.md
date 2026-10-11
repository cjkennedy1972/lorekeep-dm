# ADR-023: Hybrid fail-closed moderation classifier; judge on the `moderate` endpoint

Status: Accepted (tech-lead decision D1, 2026-10-10, under owner delegation: "act as tech lead and not ask me") · Date: 2026-10-10 · Refines ADR-007 and ADR-016 · Implements architecture §6 and §9.1 for M3 · Card M3-01

**Context.** ADR-007 leaves the input/output classifier open ("provider moderation endpoint vs cheap LLM, decided in M3"). ADR-016 makes the hard floor identical at every tier and not configurable. Spec drivers: R-S1, R-S8, R-L1, R-L5. Constraints that shape the choice:

- Player text must stay on operator infrastructure by default (ADR-017 retention and operator-only access to flagged items).
- The hard floor (sexual content involving minors, real-person harm, real-world harm instructions) must hold when the model is slow, down, or confused. It cannot fail open.
- Tier categories (table lines, veils, tier rubric) need a model judgment; deterministic rules cannot carry them.
- Measured latency (below) rules out a per-chunk reasoning-model judge as the sole first-token gate, so the first-token SLO is revised and a non-reasoning fallback is named.
- The current code uses the `moderate` slot as the solo-turn narration default (`apps/server/src/room/productionTurnRunner.ts:117`, `apps/server/src/routes/tables.ts:249`, env `SOLO_TURN_ENDPOINT_SLOT`). The classifier must not share an endpoint with narration.

**Decision.**

1. **Deterministic layer, always inline (milliseconds).** The hard-floor rules (`apps/server/src/safety/hardFloor.ts`, PR #153, open; rule categories only, no tier input) and the SRD denylist scan run first on every input and every output chunk. A hard-floor rule hit blocks alone, with no judge call. The rules are conservative keyword and proximity checks with known false negatives, so they are necessary but not sufficient.
2. **Tier and boundary classifier: LLM judge on the `moderate` endpoint.** A fixed per-tier rubric (M3-02), temperature 0, JSON-only output `{"verdict": "allow" | "block" | "hold", "category": <enum>}`, strict parse with schema validation. Any non-JSON, extra-field, or schema-invalid reply is "unparseable" and follows the fail-closed table below.
3. **Separate endpoint from narration.** The judge uses only the `moderate` slot. Narration moves off `moderate`: the solo-turn default in `productionTurnRunner.ts:117` and `tables.ts:249` changes from `moderate` to `fast` (M3-07). The operator maps `fast` to the narration host and `moderate` to the moderation host. The `moderate` slot must pass the endpoint probe so that `moderationVerified` (ADR-013) can hold. Config changes touch `apps/server/src/llm/config.ts`, `productionTurnRunner.ts`, and `orchestrator.ts`, so they are serialized per M3 rule D3.
4. **No third-party moderation API by default.** A provider-endpoint adapter may sit behind the same Moderator seam later. It is operator-enabled and must be named in the privacy notice (M3-39).
5. **Non-blocking spike.** Evaluate a small non-reasoning guard model (Llama Guard / ShieldGemma class) on an inference host. Adopt it only if it beats the judge on the red-team set and on latency. Assign later; it does not gate M3-07.

**Fail-closed behavior by category.** Unavailable means timeout, transport error, non-2xx, empty content, or unparseable verdict.

| Category | Judge available, verdict | Judge unavailable / unparseable | Notes |
|---|---|---|---|
| Hard floor: sexual content involving minors | block on rule hit or judge block | **BLOCK** (input and output) | Never fails open; identical at every tier; not configurable |
| Hard floor: real-person defamation/harm | block | **BLOCK** | Same as above |
| Hard floor: real-world harm instructions | block | **BLOCK** | Same as above |
| SRD denylist (output) | block | Deterministic, so unaffected by judge state; a scan error blocks the chunk | Runs on every chunk |
| Tier categories (table lines, veils, tier rubric) | allow / block / hold per verdict | **HOLD** (input: turn not dispatched; output: no broadcast, buffer discarded) | Sender gets a neutral message (input); copy owned by M3-10 |

A hard-floor category returns `allow` only when the rules are silent and the judge returns a successful `allow`. A judge outage therefore never produces `allow` for a hard-floor category.

**Output flow.** Each sentence chunk (first chunk at about 12 tokens) passes the gate before broadcast. On block or hold: discard the unsent buffer, regenerate, at most 2 regenerations. After the third failure, send a fixed, pre-reviewed safe redirect template (a constant, not model output). This is ADR-007's flow with the hold rule added.

**Latency budgets (used by M3-30).**

| Stage | Budget | Status |
|---|---|---|
| Deterministic layer (rules + denylist) | ms, inline | Target met by design |
| Input judge (submit time, parallel with round close; narration dispatch waits on verdict) | target <= 0.4 s | **Not met on measured judge** (1.0–1.9 s typical); M3-30 records it |
| Output chunk gate | <= 0.5 s per chunk (architecture §9.1) | **Not met on measured judge**; the gate is pipelined with generation of the next chunk, so the user-visible cost is the first-token SLO |
| First token, moderated turn, uncached | **<= 3 s** (revised from 2.5 s; architecture §9.1 allowance) | Measured in M3-30 |

Escalation: if M3-30 shows first token > 3 s, move to the guard-model option (point 5). Do not relax the hard floor or the fail-closed table to meet latency.

**Moderator seam (interface sketch, not final code).**

```ts
type Tier = 'family' | 'standard' | 'mature';
type Verdict = 'allow' | 'block' | 'hold';
type Category =
  | 'hard-floor.minors-sexual'
  | 'hard-floor.real-person-harm'
  | 'hard-floor.real-world-harm'
  | 'srd-denylist'
  | 'table-line-veil'
  | 'tier-rubric';

interface ModerationContext {
  tier: Tier;
  lines: readonly string[];
  veils: readonly string[];
  paused: boolean;
}

interface ModerationResult {
  verdict: Verdict;
  category: Category | null;
  source: 'rules' | 'denylist' | 'judge' | 'fallback';
}

interface Moderator {
  checkInput(text: string, ctx: ModerationContext, signal: AbortSignal): Promise<ModerationResult>;
  checkChunk(chunk: string, ctx: ModerationContext, signal: AbortSignal): Promise<ModerationResult>;
}
```

The seam hides the judge endpoint, the rules, and the fallback. The Room depends only on `Moderator`. A provider adapter or guard model later implements the same interface.

**Injection resistance.**
- Player text is quoted data inside a delimited `<player_input player="…">` block; the system prompt states it carries no authority (ADR-007, architecture §6).
- The judge's rubric and output schema are fixed. Text that tries to change the verdict format fails the strict parse and falls to the fail-closed row.
- The judge has no tools and no write path. A verdict can only allow, block, or hold; the architecture gives text no path to set state (ADR-004).
- Measured: one injection case was resisted (see below). This is a sample of one, so the red-team set (100 prompts, architecture §12) is the real test.

**Privacy implication (M3-39 notice).** Classifier traffic goes to the operator's `moderate` endpoint, so player text is processed on operator infrastructure. The notice must say this. Judge and rules logs (decision labels, IDs, and raw text only where needed) follow the 30-day class (ADR-017). If a provider adapter is ever enabled, the notice must name that provider and state that player text is sent to it; the adapter stays off by default.

**Measured data (2026-10-10, moderation host, qwen3.8-35b-a3b-distill-q4).**
- Four cases: benign violence, minors-sexual, hate, and injection. All four classified correctly, and the injection case was resisted.
- Latency: 1.0–1.9 s typical per call; 4.1 s worst case.
- The model is a reasoning model. `enable_thinking: false` does not disable reasoning. Small `max_tokens` returns empty content; `max_tokens` must be at least about 512, or a non-reasoning model must be used.
- Consequence: the judge cannot meet the 0.4 s input target or the 0.5 s per-chunk target on this model. The first-token SLO is therefore 3 s, and the guard-model spike is the named escalation.

**Alternatives.**
- Third-party moderation API as the default: rejected. Player text leaves operator infrastructure (ADR-017), and the hard floor would depend on a vendor's uptime.
- Judge-only, no deterministic layer: rejected. The hard floor must not depend on model availability or model judgment.
- Non-reasoning guard model as the default now: deferred. It is not measured on this stack; it becomes the escalation path if M3-30 misses the first-token SLO.
- Fail-open on judge outage for tier categories: rejected. Tier categories hold instead, which keeps unreviewed text out of the table.
- Full-turn buffering for output: rejected. It adds seconds and breaks streaming (ADR-007).

**Consequences.**
- M3-07 changes the solo-turn narration default from `moderate` to `fast` and wires the judge to `moderate`. M3-02 writes the rubric. M3-10 implements the fail-closed table and hold copy. M3-30 records first-token and per-call latency against the budgets above.
- Mature-tier verification (`moderationVerified`, ADR-016) depends on the `moderate` probe passing, so a misconfigured moderation endpoint degrades the table to `standard` rather than leaving it unprotected.
- Latency is a known miss on the current model. The first-token SLO relaxation to 3 s is a deliberate change to architecture §9.1, recorded in this ADR, not a silent change.
- The live-DM allowlist gate (PR #152, open, `LIVE_DM_ALLOWLIST_ONLY`) stays on until the classifier is wired and M3-30 records its numbers.
- The hard-floor rules (PR #153, open) are the first layer and are not sufficient alone (their own header says so); the judge is the second layer.

**Open items.** None. The non-reasoning guard-model spike is recorded as non-blocking work and is not a decision open for this ADR.

## Addendum: implementation notes (M3-08)

Recorded when M3-08 landed (#159). This addendum refines the decision above and does not change the original text. Where it differs from the moderator sketch or the injection-delimiter wording above, this addendum supersedes them.

**Moderator seam as built.** The sketch's `checkInput`/`checkChunk` pair is replaced by one method, `moderate(req)`. The request is `{text, tier, tableLines?, context?, direction}`. `direction` (`input` or `output`) selects the system framing (player input vs. game master output). The verdict is `{verdict, category, source, latencyMs, unavailable}`, where `verdict` is `allow` or `block` only. `source` is one of `hardfloor`, `denylist`, `judge`, or `failclosed`. There is no `hold` verdict: a block with `unavailable: true` means the judge could not answer, and the caller (M3-10) maps that flag to HOLD for tier categories. `hold` and per-category copy are never decided inside the moderator.

**Deterministic layer required.** `JudgeModerator` takes the hard-floor rules and the SRD denylist scan in its constructor and throws without them, so the judge cannot run alone.

**Judge reply parse.** The reply must be JSON with exactly the `verdict` and `category` fields. The parser rejects duplicate keys and any backslash, so an escaped key cannot hide a second verdict. It also rejects pairs that disagree: `allow` requires `none`, and `block` requires a non-`none` category. Anything rejected is "unparseable" and follows the fail-closed table.

**Delimiters and context.** Player text is in a `<text>` block, with `<context>` and `<table_lines>` blocks when present, each JSON-quoted with `<` and `>` escaped. The verdict applies to `<text>` alone. This replaces the `<player_input player="…">` form in the injection-resistance list. `context` is the trailing 400 characters of the preceding text, for reference only.

**Output gate bounds (`apps/server/src/safety/outputGate.ts`).**
- At most `maxInFlight` judge calls per attempt, default 2. The reader waits for a slot before cutting the next chunk (backpressure).
- Chunks are at most 400 characters. A longer run is cut at the last whitespace; if there is no whitespace, the cut is forced at 400.
- At most 20,000 characters are read per attempt. Exceeding that fails closed and enters the regenerate path.
- Whitespace-only runs are carried into the next judged chunk. Trailing whitespace at stream end is not emitted.
- Abandoning an attempt calls `return()` on the upstream iterator and aborts the `AbortSignal` passed to `regenerate`.

**Known limits (follow-ups).**
- The 20,000-character budget is per attempt. Nothing caps total read across regenerations yet, so the worst case is three attempts' worth.
- `return()` and abort run when an attempt is abandoned. An upstream that hangs without resolving is not force-closed yet. Follow-up card M3-08b.
- The `hold` decision and copy are owned by M3-10, driven by the `unavailable` flag.

**Also built.** The rubric is embedded at build time from `docs/security/moderation-rubric.md`, with a drift test. The `moderation:probe` script reads its endpoint from environment variables, is read-only, and is not run in CI.
