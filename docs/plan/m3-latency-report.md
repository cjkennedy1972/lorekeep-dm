# M3-30 latency report: uncached first token with classifier on

Status: **30-run selected-endpoint cache-off configuration sample complete; p95 MISSES the 3 s target.**

Base: origin/main at 7df49ea.

## What was checked

- The owner selected `http://172.31.25.75:8080/v1` and model `serenity-26b-a4b` for the `moderate` and `fast` slots. The endpoint is LocalAI v4.11.0.
- Prior docs identify the same URL with `qwen3.8-35b-a3b-distill-q4` as an earlier local diagnostic. That older model/config was not used for the new run.
- A five-case local moderation diagnostic authenticated using the existing local credential and reached the prior Qwen endpoint. Two cases timed out, one expected line/veil block was allowed, and only two cases matched. This is inadequate for mature-content authorization; it was not used to enable mature or qualify the endpoint.
- ADR-013 left endpoint selection open; the owner has now selected the endpoint above for this sample. The target itself is not open: ADR-023 and architecture §9.1 set **<= 3 s uncached p95**.
- LocalAI's selected model config initially had `prompt_cache_all: true` and `cache_reuse:256`. For the measured run, the API and model YAML were verified at `prompt_cache_all:false`, `cache_ram:0`, and `cache_reuse:0` before loading Serenity. The harness sent no cache hint; `prompt_cache=operator_attested_disabled` is still an operator configuration attestation, not an independently observed provider cache-hit metric.
- The earlier cache-off attempt failed to load Serenity while Qwen occupied GPU memory. On 2026-10-17, authenticated preflight showed 59.9 MB of 32.06 GB VRAM in use and no model backend resident. Serenity loaded using about 21.6 GB VRAM; no other model was stopped or unloaded.
- After the run, the original YAML was restored (`prompt_cache_all:true`, `cache_reuse:256`, no `cache_ram` key), the API reported the original cache-on settings, and VRAM returned to 59.9 MB of 32.06 GB. The model-scoped shutdown request reported an error, but the backend was no longer resident. The temporary Docker Postgres container was removed. These cleanup checks passed independently after the runner emitted a conservative restore warning because the API had inserted `cache_ram:null`; that null line was removed to restore the original file state.

## Measurement limitations and remaining decision

1. The sample uses a cold-loaded selected model, classifier-on standard-tier synthetic prompts, and a disposable migrated Docker Postgres database. It exercises no tool loop and does not include session/DB turn overhead.
2. Cache-off is evidenced by the verified LocalAI configuration and the harness guard; provider/runtime cache behavior was not independently instrumented. Treat cache-off as operator-attested, not as a measured cache-hit ratio.
3. The selected endpoint **misses** the canonical **<= 3 s p95** target, per ADR-023 and architecture §9.1. The recorded input-moderation p95 also exceeds the supporting <= 0.4 s budget; output-gate duration exceeds the card's 0.5 s supporting budget. The 2.5 s card title is stale.
4. Owner/product disposition is needed for the latency miss; do not silently relax the 3 s target. No more live calls are needed to complete this measurement card unless the owner changes the acceptance target or requests a rerun.

## Harness and measurement plan

- Harness: `pnpm --filter @game/server first-token:probe`. It runs 30–100 iterations (default 30), applies input moderation to a synthetic action, generates a production-shaped narration, buffers the complete response, then runs `runOutputGate` over 24-character chunks before recording first-visible time. It executes no tools, creates no session, writes no DB data, records no fixtures, and outputs aggregate timing plus a prompt hash only.
- The harness matches production ordering: the model response is buffered before gating, and one visible narration is emitted only after the gate. It reports nearest-rank p50/p95 for input moderation, gate duration after model completion, and first-visible narration from `outputStart`, taken immediately before the narration model request. One unmeasured model warmup per slot is excluded from measured runs.
- The script's `FIRST_TOKEN_PROBE_CACHE_DISABLED=1` is an operator attestation guard, not a technical verification by the harness. The harness sends no cache hint; provider-side automatic caching is controlled separately and must be verified from LocalAI configuration before the run.
- The harness uses a deterministic synthetic single-turn prompt and no tool loop. It exercises the prompt builder, configured adapter, classifier, and output gate, but does not cover DB/session overhead, input-gate DB reads/logging, tool loops, or real user prompt sizes. This is an engineering sample, not proof of every turn's latency.
- Targets: input moderation <= 0.4 s; first visible narration <= 3 s uncached p95. Gate duration is reported separately and is not an output-chunk-latency target.
- `pnpm --filter @game/server moderation:probe` remains available for judge-only boundary/correctness probing; it is not an end-to-end latency substitute.

## Best-judgment decision

The owner-designated endpoint/model above was used explicitly; no endpoint was inferred from prior local diagnostics. A prior authenticated synthetic request succeeded after cooldown. This is measurement authorization only; it neither enables mature content nor qualifies moderation correctness. The existing five-case moderation correctness sample remains inadequate for mature-content authorization.

## Result

### Owner-selected endpoint: cache-off configuration sample (2026-10-17)

The earlier 30-run table for `serenity-26b-a4b` used a streaming-through-the-gate harness. Production buffers the model response before gating, so those figures are not production-path measurements and are withdrawn from the SLO result. The corrected production-shaped harness has now completed 30 runs against the owner-selected model with the cache-off configuration verified immediately before model load.

| Measure | p50 | p95 | Target / budget | Result |
|---|---:|---:|---:|---|
| Input judge | 617 ms | 811 ms | <= 400 ms supporting budget | Miss |
| Output gate after model completion | 3,740 ms | 4,906 ms | <= 500 ms supporting budget | Miss |
| First visible narration from model request | 6,562 ms | 8,051 ms | <= 3,000 ms uncached p95 | Miss |

Sample size: 30. Classifier on; standard tier; no tool loop. Cache configuration was API- and YAML-verified as `prompt_cache_all:false`, `cache_ram:0`, `cache_reuse:0` before the run, then restored and checked. The harness reports `prompt_cache=operator_attested_disabled`; the endpoint does not expose an independent cache-hit measurement. Only aggregate timings and a synthetic-prompt hash are retained; no model outputs or credentials were recorded. The aggregate artifact is `docs/plan/evidence/m3-30-cache-off-2026-10-17.txt`.

### Earlier local diagnostic (not the reference configuration; legacy harness)

An earlier harness version ran 30 iterations against the prior local Qwen endpoint in an isolated temporary database schema, using synthetic standard-tier prompts. The schema was removed afterward; production operator configuration was not changed. The existing local credential was used through an environment variable and was not printed or persisted. These numbers are retained only as historical local diagnostics; they are not from the corrected cache-off run and do not establish the selected endpoint's SLO.

| Measure | p50 | p95 | Target | Result |
|---|---:|---:|---:|---|
| Input judge | 560 ms | 576 ms | <= 400 ms | Miss |
| Output gate after model completion | 3,534 ms | 6,012 ms | informational | Total gate duration across all chunks; not a per-chunk latency measurement |
| Legacy first-visible narration (timing origin unknown; withdrawn, not an SLO result) | 5,929 ms | 10,039 ms | <= 3,000 ms | Historical diagnostic only |

Sample: 30 iterations; the legacy harness's cache-hint behavior and provider-side cache state are unverified. The timing origin cannot be substantiated from the earlier harness version. No tool loop was exercised. These figures are withdrawn from the SLO result and retained only as historical local diagnostics; they do not establish the hosted-reference SLO.

**Selected endpoint result:** measured miss. First-visible narration p95 is 8.051 s against the 3 s target; input judge and output-gate supporting budgets also miss. This does not establish that the SLO passes, and provider-side cache behavior remains operator-attested rather than independently instrumented. No mature-content or moderation-correctness qualification is implied.
