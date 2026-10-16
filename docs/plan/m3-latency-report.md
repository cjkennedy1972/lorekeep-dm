# M3-30 latency report: uncached first token with classifier on

Status: **HARNESS CORRECTED; selected-endpoint measurement BLOCKED by LocalAI model-load failure. No valid uncached result is claimed.**

Base: origin/main at 7df49ea.

## What was checked

- The owner selected `http://172.31.25.75:8080/v1` and model `serenity-26b-a4b` for the `moderate` and `fast` slots. The endpoint is LocalAI v4.11.0.
- Prior docs identify the same URL with `qwen3.8-35b-a3b-distill-q4` as an earlier local diagnostic. That older model/config was not used for the new run.
- A five-case local moderation diagnostic authenticated using the existing local credential and reached the prior Qwen endpoint. Two cases timed out, one expected line/veil block was allowed, and only two cases matched. This is inadequate for mature-content authorization; it was not used to enable mature or qualify the endpoint.
- ADR-013 left endpoint selection open; the owner has now selected the endpoint above for this sample. The target itself is not open: ADR-023 and architecture §9.1 set **<= 3 s uncached p95**.
- LocalAI's selected model config initially had `prompt_cache_all: true` and `cache_reuse:256`. A temporary cache-off configuration (`prompt_cache_all: false`, `cache_ram:0`, `cache_reuse:0`) was accepted and verified, then restored. **The endpoint is currently back on its original cache-on configuration; no uncached measurement was collected.** The claim that `cache_ram:0` disables server-side prompt caching is an operator assumption, not verified against LocalAI documentation in this run.
- After the config update, the selected model returned HTTP 503 and failed to load. LocalAI placed `serenity-26b-a4b` in load cooldown; system resources showed the existing Qwen model loaded with 1.19 GB free of 32.06 GB GPU memory. No Qwen backend was shut down.

## What is needed to run M3-30

1. Make enough GPU memory available to load the owner-selected `serenity-26b-a4b` model without interrupting other active model users, then rerun the harness. Its strict uncached run requires the cache-off model config to be active and verified.
2. For another run, configure the owner-selected `moderate` and `fast` slots in a disposable database and provide the endpoint encryption key through a secret environment. Endpoint credentials are consumed by the adapter and never printed by the harness.
3. The script requires `FIRST_TOKEN_PROBE_CONFIRM=1` and `FIRST_TOKEN_PROBE_CACHE_DISABLED=1` before sending 30–100 synthetic prompts. Verify the LocalAI config before setting the latter.
4. Canonical target is **<= 3 s uncached p95**, per ADR-023 and architecture §9.1. The card's 2.5 s target is stale.

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

### Owner-selected endpoint: no valid measurement

The earlier 30-run table for `serenity-26b-a4b` used a streaming-through-the-gate harness. Production buffers the model response before gating, so those figures are not production-path measurements and are withdrawn from the SLO result. The corrected harness could not warm the selected model: LocalAI returned HTTP 503 and put it in load cooldown. The cache-off configuration was restored and the scratch database was dropped. No selected-endpoint p50/p95 is claimed.

### Earlier local diagnostic (not the reference configuration; legacy harness)

An earlier harness version ran 30 iterations against the prior local Qwen endpoint in an isolated temporary database schema, using synthetic standard-tier prompts. The schema was removed afterward; production operator configuration was not changed. The existing local credential was used through an environment variable and was not printed or persisted. These numbers are retained only as historical local diagnostics; they are not from the corrected cache-off run and do not establish the selected endpoint's SLO.

| Measure | p50 | p95 | Target | Result |
|---|---:|---:|---:|---|
| Input judge | 560 ms | 576 ms | <= 400 ms | Miss |
| Output gate after model completion | 3,534 ms | 6,012 ms | informational | Total gate duration across all chunks; not a per-chunk latency measurement |
| Legacy first-visible narration (timing origin unknown; withdrawn, not an SLO result) | 5,929 ms | 10,039 ms | <= 3,000 ms | Historical diagnostic only |

Sample: 30 iterations; the legacy harness's cache-hint behavior and provider-side cache state are unverified. The timing origin cannot be substantiated from the earlier harness version. No tool loop was exercised. These figures are withdrawn from the SLO result and retained only as historical local diagnostics; they do not establish the hosted-reference SLO.

**Selected endpoint result:** blocked; the corrected 30-run sample is not available. The previous streamed-gate result is invalid for the production-path target. Strict uncached SLO status remains **unverified** until the cache-off configuration is active and the selected model is loadable.
