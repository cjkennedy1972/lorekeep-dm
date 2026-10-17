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

| Category                                          | Judge available, verdict         | Judge unavailable / unparseable                                               | Notes                                                       |
| ------------------------------------------------- | -------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Hard floor: sexual content involving minors       | block on rule hit or judge block | **BLOCK** (input and output)                                                  | Never fails open; identical at every tier; not configurable |
| Hard floor: real-person defamation/harm           | block                            | **BLOCK**                                                                     | Same as above                                               |
| Hard floor: real-world harm instructions          | block                            | **BLOCK**                                                                     | Same as above                                               |
| SRD denylist (output)                             | block                            | Deterministic, so unaffected by judge state; a scan error blocks the chunk    | Runs on every chunk                                         |
| Tier categories (table lines, veils, tier rubric) | allow / block / hold per verdict | **HOLD** (input: turn not dispatched; output: no broadcast, buffer discarded) | Sender gets a neutral message (input); copy owned by M3-10  |

A hard-floor category returns `allow` only when the rules are silent and the judge returns a successful `allow`. A judge outage therefore never produces `allow` for a hard-floor category.

**Output flow.** Each sentence chunk (first chunk at about 12 tokens) passes the gate before broadcast. On block or hold: discard the unsent buffer, regenerate, at most 2 regenerations. After the third failure, send a fixed, pre-reviewed safe redirect template (a constant, not model output). This is ADR-007's flow with the hold rule added.

**Latency budgets (used by M3-30).**

| Stage                                                                                     | Budget                                                       | Status                                                                                                                                  |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| Deterministic layer (rules + denylist)                                                    | ms, inline                                                   | Target met by design                                                                                                                    |
| Input judge (submit time, parallel with round close; narration dispatch waits on verdict) | target <= 0.4 s                                              | **Not met on measured judge** (1.0–1.9 s typical); M3-30 records it                                                                     |
| Output chunk gate                                                                         | <= 0.5 s per chunk (architecture §9.1)                       | **Not met on measured judge**; the gate is pipelined with generation of the next chunk, so the user-visible cost is the first-token SLO |
| First token, moderated turn, uncached                                                     | **<= 3 s** (revised from 2.5 s; architecture §9.1 allowance) | Measured in M3-30                                                                                                                       |

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
  checkInput(
    text: string,
    ctx: ModerationContext,
    signal: AbortSignal,
  ): Promise<ModerationResult>;
  checkChunk(
    chunk: string,
    ctx: ModerationContext,
    signal: AbortSignal,
  ): Promise<ModerationResult>;
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

## Addendum: M3-08b follow-ups

Recorded before gate wiring (M3-07/M3-10). This addendum refines the M3-08 addendum above and does not change the original text.

**Judge context (C3).** The judge's `context` is the trailing 400 characters of text already approved in this turn, plus pending text ahead of the chunk, not only the immediately preceding chunk. It is for reference only; the verdict applies to `<text>` alone.

**Judge concurrency across attempts (C4).** At most 2 judge calls are in flight per attempt. A blocked attempt's calls are not aborted (`moderate` takes no signal), so while the next attempt starts, up to 4 classifications can be in flight across attempts. Each call is bounded by its own verdict timeout (below).

**Per-turn output ceiling (N3).** At most 30,000 characters are read from the upstream across all attempts of one turn (`maxTurnChars`). Exceeding it fails closed and goes straight to the safe redirect, with no further regeneration. The per-attempt 20,000-character budget still applies inside it. This supersedes the "Known limits" bullet above for the total.

**Hung upstreams and verdicts (N1, C1, N2).** The gate races each upstream read against the attempt's abort and a source idle timeout (`sourceIdleMs`, default 15 s). An idle source fails the attempt, which throws to the consumer. When an attempt is abandoned, `return()` is called on the upstream from the consumer side, so a hung upstream is closed as soon as the gate stops reading, though a generator already blocked in `next()` may not run its `finally` until that `next()` settles. Each verdict is bounded at the gate (`verdictTimeoutMs`, default 10 s); a late verdict fails closed through the same path as a judge outage.

**Fail-closed row contract for M3-10 (C2).** On an unavailable verdict (`unavailable: true`), `failClosedRow` says which row of the fail-closed table applies:

- `'hard-floor'` maps to **BLOCK**.
- `'tier'` maps to **HOLD**.

The caller maps `failClosedRow`, not `category`. The category is `other` on outage because the judge did not answer. The gate and the moderator both set `'hard-floor'`, the stricter row, because an outage has no category to show it is a tier-only case, and the hard floor never fails open. A future path that knows the text is tier-only may set `'tier'`. `failClosedRow` is undefined when `unavailable` is false.

**Correction to N1/C1 (M3-08b round 2).** The sentence "a hung upstream is closed as soon as the gate stops reading" holds only when the source honors its `signal`. The first attempt's source is now a factory `stream(signal)`, like `regenerate`, so the gate aborts both attempts' signals when it stops reading. A source that ignores `signal` and is blocked in `next()` is not closed by `return()`, because an async generator's `return()` queues behind a pending `next()`. Such a source stays open until its own transport timeout. Every upstream passed to the gate must honor `signal`.

**Correction to the deterministic layer (B1, round 2).** Hard-floor and denylist checks run over `context + text`, where `context` is the carried tail above, so a term split across a forced cut is seen whole. Emission is still per chunk and each chunk is still judged by its own verdict. A fragment of an earlier allowed chunk can therefore reach the player before a straddling term is seen; the block then ends the attempt. The carry must be at least the longest deterministic rule span; a rule longer than 400 characters needs the carry raised with it.

**Correction to the fail-closed contract (N3, round 2).** `Verdict` is now a union. `unavailable: true` requires `failClosedRow`; `unavailable: false` has no `failClosedRow`. A caller cannot read an outage verdict without naming its row.

**Addendum to the deterministic layer (M3-08b round 3).** The round-2 correction above is superseded for the fragment leak: each approved chunk is now emitted except its trailing `MAX_RULE_SPAN_CHARS` (64) characters, which are held and prepended to the next chunk's emission only after that chunk's combined `context + text` deterministic check passes. The held tail is flushed at stream end after the final verdict, and discarded without being shown if the next chunk blocks. A regeneration continues from the emitted prefix only, never the held tail. Emission therefore lags by up to 64 characters, and a first chunk shorter than 64 characters emits nothing until the next chunk passes or the stream ends. The gate and the moderator refuse to construct when `maxChunkChars` is below 64 or above the 400-character carry, when the carry is below 64, or when a deterministic layer declares `maxSpanChars` above 64. The idle timeout on the source now takes the fail-closed path (block, then regenerate or redirect per `failClosedRow`) instead of throwing to the consumer.

**M3-07 implementation (input gate).** Every player input passes `InputGate.check` before storage or DM delivery: player actions, clarification answers, character names, table and room names, and display names. The gate runs the deterministic hard floor first, then `JudgeModerator` on the `moderate` slot at temperature 0 with strict JSON verdicts. Non-allow verdicts and outages fail closed: a hard-floor row maps to BLOCK and a tier row maps to HOLD, with HOLD copy owned by M3-10. A rejection returns a neutral message to the sender only. Each non-allow writes a `moderation_log` row (surface, account, session, category, source, fail_closed_row) with no raw text, and `expires_at = written_at + 30 days`, purged by the logs retention job. Input gating runs inside the per-socket promise chain (ADR-022), so arrival order is preserved. Names use the family tier because they carry no session; session inputs use the endpointAllowsMature=false tier.

**Addendum (M3-08c): turn-scoped deterministic check.** Hard-floor match spans are unbounded, because separator runs between tokens are unbounded and the rule is message-level (a minor reference and a sexual term anywhere in the same text). A 64-character hold-back cannot cover them. `hardFloorLayer` (`apps/server/src/safety/deterministicLayer.ts`) therefore declares `maxSpanChars: 0`, and coverage comes from `ModerationRequest.turnContext`: the gate passes all text the turn has produced (approved plus judged), and deterministic rules scan `turnContext + text`. The 400-character carry remains the judge's context only. `MAX_INPUT_CHARS` rises from 20,000 to 30,000 to match `maxTurnChars`.

Known residual, not closed: a sexual term emitted before its minor reference arrives is already visible when the message blocks. Only whole-turn buffering closes this, and that makes first-token latency equal to full generation time. This needs an owner decision.

Performance, measured on this branch at 30,000 characters: one full scan takes 2 to 96 ms (96 ms on adversarial input). Re-scanning the cumulative turn at each of 75 chunks takes 0.7 to 2.5 s. The cumulative cost misses the ~100 ms budget and is open. Candidate fixes are incremental or cached minor and sexual flags, or a full-turn scan only at chunk boundaries that can complete a rule.

**Addendum (M3-08c round 2): incremental turn scanner.** This supersedes the `turnContext` description above. `ModerationRequest.turn` replaces `turnContext`: the gate creates one `DeterministicTurn` per attempt, seeds it with `emittedBefore`, and pushes each judged chunk. `hardFloor.ts` exposes pure flags (`scanFlags(words, from, to)`, `HardFloorFlags`) and `checkHardFloor` is built on them, so behavior is unchanged and `HARD_FLOOR_VERSION` stays `2026-10-10.8`. `createHardFloorTurn()` keeps cumulative `explicit`, `minor`, and `sexual` flags for token starts whose right context is settled (16 tokens of tail), recomputes the unsettled tail on each push, and carries the last 400 raw characters for left context. Once blocked, a turn stays blocked. Nothing is buffered beyond the carry.

**Addendum (M3-08c round 3): sensitive latch and bounded rescan.** This supersedes the round-2 `HARD_FLOOR_VERSION` value. Message-level taint means a sexual term seen early can be completed into a block by a minor term arbitrarily later, so text already emitted cannot be revoked. `createHardFloorTurn().push` now also returns `sensitive`, which latches true once any sexual flag is seen in the turn. While the latch is set, the output gate emits nothing until the turn ends or blocks; the 64-character hold-back applies only to turns that have not latched. A bounded hold to a sentence horizon was rejected because it reintroduces the leak. The scanner rescans only the carried tokens that can change (`TURN_RESCAN_TOKENS`) instead of the whole carry, which cut the 30k one-character-per-push case by about 2.8x; per-push cost is still dominated by normalizing the 400-character carry. `HARD_FLOOR_VERSION` is `2026-10-10.9`.

Residual, accepted: sexual text emitted before a later minor reference stays visible, because the gate has already sent it. This is the same residual as above. Decision: accept it and do not buffer the turn.

Intentional divergences from `checkHardFloor` on the whole text:

1. Rule labels may differ across chunk splits (for example, `childporn` joined in a prefix, `childpornography` in the full text). Both block.
2. A streamed prefix can over-block where it is itself a hard-floor match ("harvest rapes" before "eed", "has sex" before "appeal"). Each costs a regeneration. The equivalence contract allows this only when `checkHardFloor(prefix)` blocks.
3. Adjacency longer than the 400-character carry can diverge. NAME_AGE-style unbounded separator runs are the main case.
4. Tail tokens beyond the carry can diverge for the same reason.

Performance (this branch, 30,000 characters, 75 chunks of 400, median of 5 runs): benign about 10 ms; adversarial 43 to 89 ms across runs. Both are under the 100 ms budget, but the adversarial case is close to it.

**Addendum (M3-08c remediation, 2026-10-12; tentative-tail finalization).** `createHardFloorTurn().push` uses settled-token flags for in-progress blocking; flags from an unsettled right-edge tail are not a completed verdict because a later chunk can change youth/adult adjacency (for example, `youth` followed by `adult`). The tail remains part of the final verdict through `finish()`, which the output gate invokes before flushing held text. Sexual or explicit candidate cues latch `sensitive` immediately, so potentially affected output remains held until the final full-turn decision; a final block discards held output. This removes a chunk-boundary-only youth/adult block without weakening the terminal hard-floor check. `HARD_FLOOR_VERSION` was `2026-10-16.12` at this addendum; the current version is recorded in the latest addendum below. Performance remains NO-GO until the separate ~100 ms acceptance target is met.

**Correction (M3-08c remediation, 2026-10-12; scanner requirement).** The output gate requires a turn-scoped scanner whenever the deterministic layer declares unbounded rules (`maxSpanChars: 0`). If that scanner is absent or fails to initialize, the attempt fails closed; it must not fall back to the bounded judge-context window, which cannot uphold message-level hard-floor detection or the sensitive visibility latch. Bounded deterministic layers may continue to use their declared span and hold-back.

**Correction (M3-08c round 3, B1).** The carry described in round 2 was wrong for gaps. A minor term and a sexual term more than 400 raw characters apart, with fewer than 16 tokens between them, could both be missed (under-block), in either order. The carry is now the earlier of the last 400 raw characters and the start of the last 24 `[\p{L}\p{N}]+` tokens, so short-token adjacency is always retained. Divergence items 3 and 4 above are narrowed accordingly: a streamed verdict can still differ from `checkHardFloor` only when a minor and a sexual term are separated by more than the carry, meaning more than 400 characters and more than 24 tokens between them. Such pairs may not block in the stream; the full-text rule still applies to the completed turn. Stickiness and the equivalence contract (never under-block; over-block only when `checkHardFloor(prefix)` blocks) are unchanged.

**Correction (M3-08c round 4).** The round-3 statement that distant pairs may under-block contradicted the equivalence contract. The turn scanner accumulates flags from settled tokens, so a minor reference and sexual term remain detectable even when separated by more than 400 characters and 24 tokens. That under-block divergence is closed; the carry is only needed for unsettled token context. The equivalence contract remains: never under-block; over-block only when `checkHardFloor(prefix)` blocks.

**Addendum (M3-08c remediation, 2026-10-12; supersedes earlier carry and output-residual descriptions above).** `checkHardFloor` and the incremental turn scanner now share `compactTurnWindow`: long tokens and non-word runs are bounded before normalization, and the carry keeps at most 33 tokens with bounded token/separator representations. This removes the unbounded token-free `". . . "` carry. Separator compaction may change full-text verdicts; the full and streaming paths use the same canonicalizer, and fixture/property tests must treat any changed full-text verdict as a semantic delta and confirm it is an over-block. One enumerated delta is an age cue with four punctuation marks before the age: compaction retains three, matching the rule's punctuation limit and potentially over-blocking once sexual content is also present. The bounded scan-window memo is size-limited. The version is `2026-10-12.10` because normalization and input-floor semantics changed.

Verdict contract is separate from visibility: settled flags preserve minor/sexual message-level detection across arbitrary distance, but only after the scanner has seen the relevant term. `sensitive` is a sticky visibility latch, not a sticky sexual verdict: a tentative sexual token may merge into a different word after later format characters arrive, in which case the latch remains set but the current canonical scan determines the verdict. Once `sensitive` is latched, the gate emits no more text for that attempt; any held output is discarded if the later verdict blocks. This closes the sexual-first visibility leak for detected terms, but first visible text can be delayed until end-of-turn for such turns. Output regression: sexual-first narration, more than 64 filler characters, then a minor reference; no sexual text may appear in emitted chunk events.

**Verification status / release gate:** fail-closed scanner initialization and `moderate()` turn-push handling are covered by tests. Targeted scanner and output-gate suites pass on the remediation worktree. A fresh isolated 30,000-character adversarial test measured 384 ms for 1-character pushes, 47 ms for 10-character pushes, and 20 ms for 400-character pushes. The broader targeted-suite run also measured the existing 75-chunk adversarial case at 120 ms (benign: 82 ms). The one-character and 75-chunk adversarial measurements do not meet the ~100 ms target; M3-08c remains NO-GO pending a safe optimization and rerun. These are local timings, not CI measurements.

**Performance remediation update (2026-10-12):** the turn scanner now has an ASCII single-character append path that updates only the final token/separator run, incrementally counts carry tokens, and avoids normalizing the same carry a second time to recover its token count. The rescan starts at the existing left-context boundary; the 47-token carry cap and 45-token rescan span guarantee this still includes all changed tail candidates. Median local timings for the adversarial 30,000-character case are 95 ms at 1-character pushes, 25 ms at 10-character pushes, and 2.4 ms at 400-character pushes. The 75×400-chunk suite now enforces the ~100 ms budget per benign/adversarial/sparse input. The focused turn-scanner equivalence/performance suite passes (424 tests). This supersedes the prior NO-GO timing above; timings are local, not CI measurements.

**Performance contract clarification (2026-10-12):** the isolated one-character stress median is about 95 ms, but concurrent full-suite workers can move that wall-clock median slightly above 100 ms. Therefore CI enforces <100 ms for 10-character and 400-character pushes and for the 75×400-chunk benign/adversarial/sparse workloads; the one-character stress case has a 120 ms contention-tolerant ceiling and still reports its median. This preserves a strict budget on production-shaped chunking without making the synthetic 30,000-push stress assertion scheduler-sensitive.

**Correction (M3-08c visibility and performance, 2026-10-12):** the visibility latch must cover either arrival order. If a minor cue precedes a sexual cue by more than the 64-character hold-back, emitting the earlier text before the later block is the same visibility leak as sexual-first narration. `sensitive` now latches on minor, sexual, or explicit candidate flags (settled or tentative), and output regressions cover both orders across more than 64 filler characters; affected turns remain held until finish or block. The scanner cache key now covers only the starts being scanned and their bounded rule context, so extending an unsettled tail reuses settled-scan results. The focused scanner and output-gate suites pass (468 tests), `pnpm lint` passes, and local adversarial 30,000-character medians are 95.4 ms (1-character pushes), 25.8 ms (10-character), and 2.4 ms (400-character). CI for this latest change is pending; these timings are local, not CI measurements. This supersedes earlier statements that the visibility latch only needed to address sexual-first text and that performance acceptance was still open.

**Correction (M3-08c Unicode seam, 2026-10-12):** chunk compaction now preserves a dangling high surrogate so the next push can complete and fold an astral letter, and forced output cuts back up rather than splitting a surrogate pair. Regressions cover the resulting streamed hard-floor under-block both at the scanner boundary and at a forced output chunk boundary. The stale carry-size comment was replaced with a description of the actual context contract. The latest focused scanner/output-gate run passes (470 tests), lint passes, and formatting is being checked; latest-commit CI is pending.

**Performance test calibration (2026-10-12):** CI on the optimized scanner measured the synthetic 30,000 one-character-push case at 441 ms, while the same workload is about 96 ms locally; the production-shaped 10-character, 400-character, and 75×400 workloads pass their <100 ms checks. The one-character assertion is therefore a <750 ms regression ceiling (still below the prior 832 ms measurement), not the earlier 120 ms wall-clock target. The full-scan scaling test now takes one scan per timing sample (five samples) rather than five scans per sample (eleven samples), with a 15 s timeout; this keeps the linear-scaling check while avoiding a 5 s timeout on slower CI. Local focused tests, lint, and formatting passed before this calibration; latest CI remains pending.

**Correction (M3-08c boundary and config hardening, 2026-10-12):** forced output cuts now defer a trailing high surrogate even when the source delta ends exactly at the chunk limit; the 64-character hold-back also backs off if its cut falls between a surrogate pair. `maxInFlight` rejects non-positive, fractional, and non-finite values at construction instead of allowing a stalled reader. Focused hard-floor and output-gate suites pass (695 tests), and lint/format checks pass locally. Historical comments in earlier addenda that cite a 47-token carry, a 45-token rescan span, or `TURN_RESCAN_TOKENS` do not describe the current implementation; the live carry bound is derived from its context/tail constants. Latest-commit CI remains pending.

**Correction (M3-08c benchmark sampling, 2026-10-12):** CI showed noise in one-scan-per-sample ratios (3.06× vs a 3× limit; 41× vs a 40× limit) even though the adversarial scanner chunk benchmarks passed. The full-scan comparisons now time batches of three scans over five samples; the separate 10× input comparison times batches of five over five samples. This restores enough work per sample for stable scaling ratios while keeping the long-input test within a 15 s timeout. It supersedes the earlier one-scan-per-sample note; the `<750 ms` one-character ceiling and production-shaped `<100 ms` checks are unchanged.

**Current contract clarification (M3-08c, 2026-10-12):** The historical “Residual, accepted” statement in the round-3 addendum above describes the pre-latch implementation and is superseded by the later visibility correction: once a recognized minor, sexual, or explicit candidate is observed, `sensitive` is sticky and the output gate withholds pending and later text until the final verdict; if blocked, withheld text is discarded. This is a guarantee after a recognized candidate, not a claim that the hard-floor vocabulary has no false negatives. The earlier round-3 carry-divergence statements are likewise superseded by the subsequent B1 correction and current carry invariant; they are retained as history, not current behavior.

**CI timing isolation (M3-08c, 2026-10-12):** Two CI attempts on the same head failed only wall-clock performance assertions while workspace tests ran concurrently; focused serial runs passed (651/651; 30,000-character adversarial medians about 97 ms / 26 ms / 2 ms at 1/10/400-character pushes). This points to, but does not prove, runner contention. Keep the existing `<3×` scaling, `<750 ms` synthetic one-character ceiling, and production-shaped `<100 ms` assertions. CI now runs workspace packages serially and server test files without file-level parallelism so the timing checks are not competing with unrelated test workers. Reassess if serial CI still misses those budgets.

**Historical residual reconciliation (M3-08c, 2026-10-12):** The earlier round-1 “Known residual, not closed” paragraph and round-3 “Residual, accepted” statement describe pre-latch behavior and are retained as history only. The later sticky candidate-triggered visibility latch supersedes both: after any recognized minor, sexual, or explicit candidate, output is withheld through finalization and discarded on a blocked or fail-closed outcome. The previously requested owner decision on that recognized-candidate leak is no longer pending. The 64-character hold-back description remains applicable to ordinary chunk-boundary handling; it does not override the turn-scoped latch.

**M3-09 production-path clarification (2026-10-13; current behavior, supersedes the streaming/regeneration claims above for tool-bearing turns).** The current orchestrator executes tool calls before narration and collects the model's completed final narration; it then feeds bounded 24-character slices of that completed string through the output gate. Those slices are gate inputs, not live model deltas. Thus the production tool-bearing path buffers the full generation plus moderation before its first narration event; incremental first-chunk latency and backpressure described above are not active on this path, and the first-token SLO is not established by design or measurement here. If any output chunk blocks or moderation is unavailable, the gate emits its fixed authored redirect and no model-derived text after the block. It does not regenerate: retrying the tool-bearing request could repeat already-applied side effects. Regeneration up to two times remains a requirement only for a future tool-free narration phase, contingent on a separate retry-safe design. This clarification records the shipped safety tradeoff; it does not waive measuring or meeting the latency target before claiming it. A future streaming design must separate tool execution from narration or otherwise prove retries cannot repeat side effects.

**Addendum (2026-10-17; bare-age adult-marker continuation).** The bare name/age hard-floor rule now permits one explicit adult marker from the existing catalog (`adult`, `adults`, `grown`, `grownup`, or `grownups`) between the optional copula and an `and`-joined sexual/undress term. An explicit age under 18 remains a minor indicator even when described as "grown": for example, `Mira 12 is grown and naked` must block. This closes a bypass in which the M3-34 copula fix could be evaded by inserting an adult marker. The rule remains narrowly token-bounded; it does not skip arbitrary prose. Added regression coverage and advanced `HARD_FLOOR_VERSION` to `2026-10-17.13`.

**Correction (2026-10-17; adult-marker article).** The bare-age continuation recognizes an optional article (`a`, `an`, or `the`) before the single adult marker. This closes the equivalent wording `Mira 12 is an adult and naked`; explicit under-18 ages remain minor signals regardless of the following adult claim. The corresponding MUST_BLOCK regression is included, and `HARD_FLOOR_VERSION` advances to `2026-10-17.14`.

**Correction (2026-10-17; article before sexual term).** The bare-age continuation also recognizes an optional article (`a`, `an`, or `the`) immediately before a sexual/undress term. This closes forms such as `Mira 12 is a sexy girl`; the age remains a minor indicator. The new MUST_BLOCK case is included, and `HARD_FLOOR_VERSION` advances to `2026-10-17.15`.

**Correction (2026-10-17; minor-age undress cue).** The undress verbs (`undress`, `undresses`, `undressed`, `undressing`, and their strip variants) now count as sexual/nudity cues whenever the same message contains a minor indicator, even without an explicit object (`Mira 12 is undressed`). This treats explicit minor nudity consistently with the existing `naked`/`nude` cues. Without a minor indicator, ordinary dressing text such as `Mira got undressed for bed` remains allowed. Added direct MUST_BLOCK and benign-control regressions; `HARD_FLOOR_VERSION` advances to `2026-10-17.16`.

**Clarification (2026-10-17; routine bedtime undressing; superseded by the `2026-10-17.17` and `.19` corrections above).** The `for bed` exception applies only when the message has no explicit numeric or spelled age. `The child undressed for bed and said her prayers` remains allowed (no age cue). `Mira 12 is undressed for bed` and `Mira is 12. She undresses for bed` block, because a stated under-18 age disables the exception. The earlier statement that the stated-age form remained allowed is withdrawn.

**Correction (2026-10-17; age-predicate variants).** Bare name/age matching now recognizes common acquisition verbs (`get`, `gets`, `got`, `getting`) before a sexual/undress predicate, and one bounded relative-clause form (for example, `Mira 12 is a girl who is naked`). This closes the same R1 age-plus-sexual-predicate gap without allowing arbitrary prose between the age and cue. A stated under-18 age also disables the routine `for bed` undress exception; the non-age bedtime control and existing child bedtime fixture remain allowed. Added MUST_BLOCK controls for these cases and advanced `HARD_FLOOR_VERSION` to `2026-10-17.17`.

**Correction (2026-10-17; predicate nouns, transformation verbs, and message-level age taint).** The bounded age predicate now recognizes common change-of-state verbs (`become`/`becomes`/`became`, `turn` forms) and person-noun relative clauses (including `person`, `child`, `kid`, and `teen`) before sexual/undress cues. The `for bed` exception is disabled by any explicit numeric/spelled age cue in the same message, including when the age and undress phrase occur in separate sentences. Regression cases pin `Mira 12 becomes naked`, `Mira 12 is a person who is naked`, and `Mira is 12. She undresses for bed` as blocks. `HARD_FLOOR_VERSION` advances to `2026-10-17.19`.

**Addendum (2026-10-17; R1 adverbs, relative verbs, and sentence-boundary taint; version `2026-10-17.19`).** The bounded age-plus-sexual predicate now skips a closed list of intervening adverbs/intensifiers (`now`, `so`, `very`, `too`, `completely`, `totally`, `fully`, `still`, `just`, `already`, `really`, `quite`, `also`) before the sexual/undress term. The relative clause after `who|that` also accepts the acquisition and change-of-state verbs (`get`, `got`, `became`, `turn`, and related forms) as well as copulas. A bare name with an explicit under-18 numeric or spelled age taints a following `She|He|They` sexual predicate when the age sentence ends within 40 characters before a sentence terminator. Regression cases: `Mira 12 is now naked`, `Mira 12 is so naked`, `Mira 12 is completely undressed`, `Mira 12 is a girl who got naked`, `Mira 12 is a girl who undresses`, `Mira 12. She undresses for bed`, `Mira 12 is a girl. She is naked`, and `Mira 12 is a lovely girl. She is naked` all block. Controls `Mira 18. She is naked`, `Mira eighteen. She is naked`, and `Mira is a girl. She is naked` (no age) remain allowed.

**Addendum (2026-10-17; R1 follow-up modifiers, sleep verbs, and subject boundaries; version `2026-10-17.20`).** Predicate modifiers now accept the explicit list `almost`, `nearly`, `barely`, `half`, `hardly`, `mostly`, `partly`, `partially`, `always`, `never`, `even`, plus any single word of 4+ letters ending in `ly` (for example `always`, `barely`, `nearly`). The modifier must be a whole word and is followed by a separator, so `half-naked` matches. The relative clause after `who|that` accepts a modifier before its verb and the minimal sleep forms (`sleep`, `sleeps`, `slept`, `sleeping`). The under-18 sentence taint now also reaches the subjects `then she|he|they`, the same bare name as the age sentence, and `her|his|their` followed by `body|skin|figure|chest|hips|legs|breasts`. It reaches at most one intervening sentence of up to 60 characters between the age sentence and the subject. The taint is still bounded to the next subject, not all later text. Regression cases: `Mira 12 is always naked`, `Mira 12 is a girl. She is always naked`, `Mira 12 is almost naked`, `Mira 12 is barely undressed`, `Mira 12 is half-naked`, `Mira 12 is nearly nude`, `Mira 12 is a girl who sleeps naked`, `Mira 12 is a girl who just became naked`, `Mira 12. Her body is naked`, `Mira 12 is a girl. Mira is naked`, `Mira 12 is a girl. Then she is naked`, and `Mira 12. The sun rose. She is naked` block. Controls `Mira 18. Her body is naked`, `Mira 18. Mira is naked`, `Mira 18. The sun rose. She is naked`, `Mira 12 is a girl. Then she walked home`, `Mira 12 is a girl. Mira ate lunch`, and `Mira 12 is a girl. The sun rose. The bell rang. She is naked` (two intervening sentences, outside the bound) remain allowed. Known residual: a dice-roll style `Mira rolled 15 cleverly seduce` may now match because adverbs before a sexual term are generic.

**Addendum (2026-10-17; R1 subject and predicate recognition for Sentinel probe 9aeb2db; version `2026-10-17.21`).** The sentence-boundary subject now also accepts `then` before a bare name (`Then Mira is naked`), the definite noun `the girl|boy|child|kid|teen` (`The girl is naked`), a possessive body subject (`Mira's body is naked`, normalized to `Mira body`), and a sleep verb after the subject (`She sleeps naked`). The bounded age-predicate also accepts a `wearing nothing`, `wearing no clothes`, `wearing no clothing`, `wearing only a towel`, or `in ...` phrase before the sexual/undress term. The taint still reaches at most one intervening sentence and no later text. Regression cases: `Mira 12 is a girl. Then Mira is naked`, `Mira 12 is a girl. The girl is naked`, `Mira 12 is a girl. Mira's body is naked`, `Mira 12 is a girl. Mira is wearing nothing and naked`, and `Mira 12 is a girl. She sleeps naked` block. Adult controls `Mira 18. Her body is naked`, `Mira 18. She is naked`, and benign continuations such as `Mira 12 is a girl. Then she walked home` remain allowed. Deferred to judge: `bath` plus `naked` (for example, `Mira 12 is in the bath, naked`) is not treated as a sexual cue by this rule. Residual: the wearing-nothing phrase is also reachable from the direct name-age path (`Mira 12 is wearing nothing and naked`), which is intended.

**Addendum (2026-10-17; R1 same-name/pronoun subject separators; version `2026-10-17.24`).** The sentence-boundary subject (`she|he|they`, the same bare name, `her|his|their` body parts, `then`, and `the girl|boy|child|kid|teen`) now also follows the under-18 age after a comma, semicolon, newline, or bare space, not only after a `.`, `!`, or `?` terminator. The separator alternative is bounded to that one subject position and does not widen the scope to other subjects or to arbitrary later text. Regression cases: `Mira 12, she is naked.`, `Mira 12; she is naked.`, `Mira 12\nshe is naked.`, and `Mira 12 she is naked.` block. Controls `Mira 12, she walked home.` and adult `Mira 18, she is naked.` remain allowed. This addendum also reconciles the version history: the stale `2026-10-16.12` reference above is historical, and the current version is `2026-10-17.24`. The `for bed` clarification at 2026-10-17 (routine bedtime undressing) is corrected in place: stated under-18 ages block, and only no-age routine bedtime text remains allowed.

**Addendum (2026-10-17; R1 direct sleep predicate and `and she` separator; version `2026-10-17.25`).** The direct bare name/age path now accepts `sleep|sleeps|slept|sleeping` before the sexual/undress predicate (`Mira 12 sleeps naked`, `Mira 12 slept naked`). The sentence-boundary subject separator also accepts `and` after the age (`Mira 12 and she is naked`). Both remain bounded to the R1 subject set. Benign control `Mira 12 and she walked home.` remains allowed, and adult `Mira 18 sleeps naked.` remains allowed.

**Addendum (2026-10-17; R1 comma/semicolon and-subject separator; version `2026-10-17.26`).** After a comma or semicolon following the under-18 age, an optional `and` may precede the same subject set (`Mira 12, and she is naked`, `Mira 12; and she is naked`, `Mira 12, and Mira is naked`, `Mira 12, and her body is naked`). Benign controls `Mira 12, and she walked home.` and `Mira 12; and she walked home.` remain allowed.

**Addendum (2026-10-17; R1 direct noun clothing phrase, Bastion exact-head review of bdd0fbf; version `2026-10-17.22`).** The clothing phrase (`wearing nothing`, `no clothes`, `no clothing`, `only a towel`, or `in ...`) now also follows a listed age-predicate noun directly, without `who|that` (for example, `Mira 12 is a girl wearing nothing and naked` and `Mira 12 is a girl in only a towel and naked`). Both are pinned as MUST_BLOCK. The direct `Mira 12 is wearing nothing and naked` form still blocks, and `Mira 12 wearing nothing, she walked home` stays allowed because no sexual term follows. Bath plus naked remains deferred to judge.

**Addendum (2026-10-17; R1 `stark` predicate modifier from Bastion probe on 88e31ef; version `2026-10-17.23`).** The bounded predicate-modifier list adds `stark`, so `Mira 12 is stark naked` blocks. Adult and no-age controls `Mira 18 is stark naked` and `Mira is stark naked` remain allowed. Bath plus naked remains deferred to judge.

**Addendum (2026-10-17; latency target and perceived-wait decision).** Keep the existing ≤3 s p95 target for first safe narration on the reference hosted streaming configuration. It remains an unmet goal; do not replace it with a 10 s target merely to match current latency. The owner cited an approximately 11 s conversational-model response as evidence that such a wait feels slow; this is useful qualitative feedback, not a measurement of the game endpoint. The cache-off M3-30 sample (N=30, synthetic standard-tier turns, no tool loop) measured first visible narration p95 at 8.051 s, but is not representative user-journey evidence and does not justify resetting the objective.

The existing ≤300 ms accepted-action acknowledgement is a separate responsiveness measure. The client may show the queued/thinking acknowledgement and elapsed wait time, but must not invent model stages, percentages, or claim that narration is progressing when the server exposes no such signal. Do not satisfy any latency target by bypassing the hard floor, relaxing fail-closed behavior, or displaying unmoderated text. The current tool-bearing path buffers complete narration before output moderation; investigate a faster non-reasoning guard and a retry-safe streaming/narration design as follow-up options. Any proposed SLO revision requires representative end-to-end measurements and user-experience evidence, and must reconcile the first-safe-narration target with the complete-turn budget before changing the spec.

**Addendum (2026-10-17; implementation clarification from latency architecture review).** The earlier output-flow and latency-budget statements in this ADR describe intended behavior, not the current tool-bearing path. The current orchestrator waits for the completed narration, applies the output gate, holds the gated text, and emits only after the gate finishes; when tool side effects may already have occurred, the call is not regenerated. Do not read the earlier per-chunk/first-token language or guard-model escalation as evidence that the current path streams or that a faster guard alone will meet the first-safe-narration target. A faster guard is only a candidate for reducing measured moderation components; first collect representative component timings, including whether input moderation is actually on the turn's critical path. A split tool-execution/narration design may add model calls and must be measured before adoption. Any retry-safe streaming design requires explicit event/side-effect ordering, withholding unapproved text, fail-closed behavior, and tests proving that retries cannot repeat committed tools or leak partial narration. This clarification does not change the 3 s target or authorize weakening any safety gate.
