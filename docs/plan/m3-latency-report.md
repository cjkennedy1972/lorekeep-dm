# M3-30 latency report: uncached first token with classifier on

Status: **N=30 Serenity rerun completed with operator-attested cache-off; p95 first-visible from model request is 6.306 s and misses the <=3 s target. A supplemental GPT-6-Luna API run also completed N=30 and missed the target; it used provider-managed cache and a compatibility shim, so it is not a cache-off or directly adapter-equivalent result.**

Base: origin/main at c422514 (feat(memory): registry turn linkage for rewind, #194).

## What was checked

- The owner selected `http://172.31.25.75:8080/v1` and model `serenity-26b-a4b` for the `moderate` and `fast` slots. The endpoint is LocalAI v4.11.0.
- Prior docs identify the same URL with `qwen3.8-35b-a3b-distill-q4` as an earlier local diagnostic. That older model/config was not used for the new run.
- A five-case local moderation diagnostic authenticated using the existing local credential and reached the prior Qwen endpoint. Two cases timed out, one expected line/veil block was allowed, and only two cases matched. This is inadequate for mature-content authorization; it was not used to enable mature or qualify the endpoint.
- ADR-013 left endpoint selection open; the owner has now selected the endpoint above for this sample. The target itself is not open: ADR-023 and architecture §9.1 set **<= 3 s uncached p95**.
- LocalAI's selected model config initially had `prompt_cache_all: true` and `cache_reuse:256`. A temporary cache-off configuration (`prompt_cache_all: false`, `cache_ram:0`, `cache_reuse:0`) was accepted and verified, then restored. At the time of this initial report the endpoint was back on its original cache-on configuration; for the 2026-10-17 rerun the owner reported cache disabled (operator-attested, not independently observed). LocalAI documents `cache_ram:0` as disabling server-side prompt caching ([cache configuration](https://localai.io/docs/advanced/index.print.html)).
- After the config update, the selected model returned HTTP 503 and failed to load. LocalAI placed `serenity-26b-a4b` in load cooldown; system resources showed the existing Qwen model loaded with 1.19 GB free of 32.06 GB GPU memory. No Qwen backend was shut down.

## Remaining measurement gaps after the 2026-10-17 rerun

1. The sample is N=30; run N=100 for a more stable p95 before making a remediation claim.
2. Start an end-to-end clock at player submit and separately measure the <=300 ms WebSocket acknowledgement and DB/session overhead. The current first-visible clock starts at the narration request.
3. Record model time-to-first-token and completion separately, plus output-gate call count and per-call durations. Report stage distributions from the same iterations; do not add component p95s.
4. Keep cache-off explicitly operator-attested unless LocalAI provides an independent cache-hit metric. The canonical target remains **<= 3 s uncached p95**, per ADR-023 and architecture §9.1; the card's 2.5 s target is stale.

## Harness and measurement plan

- Harness: `pnpm --filter @game/server first-token:probe`. It runs 30–100 iterations (default 30), applies input moderation to a synthetic action, generates a production-shaped narration, buffers the complete response, then runs `runOutputGate` over 24-character chunks before recording first-visible time. It executes no tools, creates no session, writes no DB data, records no fixtures, and outputs aggregate timing plus a prompt hash only.
- The harness matches production ordering: the model response is buffered before gating, and one visible narration is emitted only after the gate. It reports nearest-rank p50/p95 for input moderation, gate duration after model completion, and first-visible narration from the start of the narration model request. One unmeasured model warmup per slot is excluded from measured runs.
- The script's `FIRST_TOKEN_PROBE_CACHE_DISABLED=1` is an operator attestation guard, not a technical verification by the harness. The adapter receives a stable-prefix cache hint, but this LocalAI OpenAI-compatible endpoint's server cache state is controlled separately and must be verified from LocalAI configuration before the run.
- The harness uses a deterministic synthetic single-turn prompt and no tool loop. It exercises the prompt builder, configured adapter, classifier, and output gate, but does not cover DB/session overhead, input-gate DB reads/logging, tool loops, or real user prompt sizes. This is an engineering sample, not proof of every turn's latency.
- Targets: input moderation <= 0.4 s; first visible narration <= 3 s uncached p95. Gate duration is reported separately and is not an output-chunk-latency target.
- `pnpm --filter @game/server moderation:probe` remains available for judge-only boundary/correctness probing; it is not an end-to-end latency substitute.

## Best-judgment decision

The owner-designated endpoint/model above was used explicitly; no endpoint was inferred from prior local diagnostics. A prior authenticated synthetic request succeeded after cooldown. This is measurement authorization only; it neither enables mature content nor qualifies moderation correctness. The existing five-case moderation correctness sample remains inadequate for mature-content authorization.

## Owner disposition (2026-10-17)

Keep the existing thresholds unchanged and record the measured first-visible misses as unmet goals. The supplemental GPT-6-Luna run used OpenAI's API directly; it does not justify a provider-only change or another provider comparison. Proceed with M4 app development. Latency remains an acknowledged product gap and may be revisited as part of application/architecture work, without weakening moderation or safety behavior.

## Result

### Owner-selected endpoint: initial attempt blocked (superseded by 2026-10-17 rerun)

The earlier 30-run table for `serenity-26b-a4b` used a streaming-through-the-gate harness. Production buffers the model response before gating, so those figures are not production-path measurements and are withdrawn from the SLO result. The corrected harness could not warm the selected model: LocalAI returned HTTP 503 and put it in load cooldown. The cache-off configuration was restored and the scratch database was dropped. No selected-endpoint p50/p95 is claimed.

### Earlier local diagnostic (not the reference configuration; legacy harness)

An earlier harness version ran 30 iterations against the prior local Qwen endpoint in an isolated temporary database schema, using synthetic standard-tier prompts. The schema was removed afterward; production operator configuration was not changed. The existing local credential was used through an environment variable and was not printed or persisted. These numbers are retained only as historical local diagnostics; they are not from the corrected cache-off run and do not establish the selected endpoint's SLO.

| Measure | p50 | p95 | Target | Result |
|---|---:|---:|---:|---|
| Input judge | 560 ms | 576 ms | <= 400 ms | Miss |
| Output gate after model completion | 3,534 ms | 6,012 ms | informational | Total gate duration across all chunks; not a per-chunk latency measurement |
| First visible narration from narration-request start | 5,929 ms | 10,039 ms | <= 3,000 ms | Miss |

Sample: 30 iterations; the legacy harness did not request cache hints, and provider-side caching could not be disabled or observed. No tool loop was exercised. This local result is engineering evidence only and does not establish the hosted-reference SLO.

### Owner-selected endpoint: operator-attested cache-off rerun (2026-10-17)

The corrected harness completed N=30 after the owner reported cache disabled and confirmed this synthetic run. Results and scope are recorded in `docs/plan/evidence/m3-30-serenity-operator-cache-off-rerun-2026-10-17.txt`.

| Measure | p50 | p95 | Target / budget | Result |
|---|---:|---:|---:|---|
| Input judge | 353 ms | 365 ms | <= 400 ms supporting budget | Pass in this sample |
| Output gate after model completion (unscored whole-response diagnostic) | 3,222 ms | 3,962 ms | Per-chunk <= 500 ms budget | UNMEASURED per chunk; whole-response duration only, not scored |
| First visible narration from model request | 5,346 ms | 6,306 ms | <= 3,000 ms p95 | Miss |

This is operator-attested cache-off, not independent provider cache verification. The clock starts at narration-model request, not player submit; DB/session overhead, WebSocket acknowledgement, per-model TTFT/total split, per-gate-call timings, tool loops, and real prompt distribution are not measured. The run is an engineering sample and **does not meet the first-visible p95 target**. The prior streamed-through-the-gate sample remains withdrawn.

### Supplemental OpenAI API run: GPT-6-Luna (2026-10-17)

The same synthetic prompt and N=30 measured iterations completed against OpenAI API model `gpt-6-luna`. The API does not accept the harness adapter's `max_tokens` or `temperature` parameters for this model. A temporary local compatibility proxy translated `max_tokens` to `max_completion_tokens`, omitted unsupported `temperature`, and increased only the unmeasured 8-token narration warmup budget to 128; the temporary probe copy allowed that warmup to complete without requiring emitted text. The sampled moderation calls therefore used the provider's default temperature rather than the harness's intended deterministic temperature 0. Treat these figures as an API-path diagnostic, not a directly comparable run of the unmodified adapter.

Prompt caching remained provider-managed and was not independently disabled or verified. Preflight/compatibility requests and the warmups are excluded from N=30. The temporary Docker database and local proxy were removed, no permanent endpoint configuration was changed, and the API key was read from the one-line checkout key file without printing or persisting it.

| Measure | p50 | p95 | Target / budget | Result |
|---|---:|---:|---:|---|
| Input judge | 846 ms | 1,199 ms | <= 400 ms supporting budget | Miss |
| Output gate after model completion (unscored whole-response diagnostic) | 3,334 ms | 5,740 ms | Per-chunk <= 500 ms budget | UNMEASURED per chunk; whole-response duration only, not scored |
| First visible narration from model request | 8,219 ms | 11,545 ms | <= 3,000 ms p95 | Miss |

The timer still starts at narration-model request, not player submit. DB/session overhead, WebSocket acknowledgement, per-model TTFT/total split, per-gate-call timings, tool loops, and real prompt distribution are not measured. This is an engineering sample and **does not meet the first-visible p95 target**. Detailed execution notes are in `docs/plan/evidence/m3-30-gpt-6-luna-openai-api-rerun-2026-10-17.txt`.
