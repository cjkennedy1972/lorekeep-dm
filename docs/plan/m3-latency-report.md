# M3-30 latency report: uncached first token with classifier on

Status: **HARNESS READY; local diagnostic completed; reference measurement BLOCKED.**

Base: origin/main at c422514 (feat(memory): registry turn linkage for rewind, #194).

## What was checked

- No endpoint URL/model or production endpoint configuration is checked into this checkout or `.env.example`; the shell does not define the standalone `MODERATION_PROBE_URL`/`MODERATION_PROBE_MODEL` variables.
- Existing docs identify `http://172.31.25.75:8080/v1` and `qwen3.8-35b-a3b-distill-q4` as the prior **local diagnostic** endpoint, not the hosted reference. No endpoint was treated as reference by inference.
- A five-case local moderation diagnostic authenticated using the existing local credential and reached the prior Qwen endpoint. Two cases timed out, one expected line/veil block was allowed, and only two cases matched. This is inadequate for mature-content authorization; it was not used to enable mature or qualify the endpoint.
- ADR-013 leaves the reference endpoint choice open. The target itself is not open: ADR-023 and architecture §9.1 set **<= 3 s uncached p95**.

## What is needed to run M3-30

1. The reference configuration owner must select/confirm the `moderate` judge endpoint and the `fast` narration endpoint. Both slots must be operator-configured in the database for the full-path harness.
2. Provide database access and `OPERATOR_ENDPOINT_MASTER_KEY` through the normal secret environment. Credentials are consumed by the server adapter and never printed by the harness.
3. Permit 30–100 synthetic prompts to be sent to both selected endpoints; the script requires `FIRST_TOKEN_PROBE_CONFIRM=1` for that reason.
4. Use the canonical target: **<= 3 s uncached p95**, per ADR-023 and architecture §9.1. The card's 2.5 s target is stale.

## Harness and measurement plan

- Harness added: `pnpm --filter @game/server first-token:probe`. It runs 30–100 iterations (default 30), calls the configured moderate judge on a synthetic player action, calls the configured fast slot with a synthetic production-shaped prompt, then gates that actual response through `runOutputGate` before recording the first-visible time. It executes no tools, creates no session, writes no DB data, records no fixtures, and outputs aggregate timing plus a prompt hash only. It requires the explicit `FIRST_TOKEN_PROBE_CONFIRM=1` opt-in before sending prompts.
- The harness measures input judge, output gate after model completion, and full first-visible narration from narration-request start. It reports nearest-rank p50/p95. No cache hints are passed; provider-side caching cannot be forcibly disabled by this API, so results must be described as **uncached-intended**, and provider caching state disclosed if known.
- The harness uses a deterministic synthetic single-turn prompt and no tool loop. Thus it exercises the real prompt builder, configured streaming adapter, classifier, and output gate, but does not cover DB/session overhead, input-gate DB reads/logging, tool loops, retries, warmup behavior, or real user prompt sizes. The current orchestrator buffers the narration adapter's full response before running `runOutputGate`; therefore `first_visible_narration_from_model_request` reflects that production ordering, rather than adapter TTFT. It is an engineering SLO sample, not proof of every turn's latency.
- Targets: input moderation <= 0.4 s; output gate <= 0.5 s per chunk (also inspect count/latencies only if extended); first visible narration <= 3 s p95. Compare measured percentiles and disclose sample size/config provenance.
- `pnpm --filter @game/server moderation:probe` remains available for judge-only boundary/correctness probing; it is not an end-to-end latency substitute.

## Best-judgment decision

The prior local Qwen endpoint at `http://172.31.25.75:8080/v1` is not the hosted reference configuration. An unauthenticated request returned 401; the authenticated 30-run diagnostic confirms the saved credential and model are usable. Its results cannot establish the reference SLO, and the moderation correctness sample was inadequate for mature-content authorization. Do not substitute it silently.

## Result

### Local diagnostic (not the reference configuration)

Ran the new harness for 30 iterations against the prior local Qwen endpoint in an isolated temporary database schema, using synthetic standard-tier prompts. The schema was removed afterward; production operator configuration was not changed. The existing local credential was used through an environment variable and was not printed or persisted.

| Measure | p50 | p95 | Target | Result |
|---|---:|---:|---:|---|
| Input judge | 560 ms | 576 ms | <= 400 ms | Miss |
| Output gate after model completion | 3,534 ms | 6,012 ms | <= 500 ms per chunk | Not directly comparable (this is total gate duration across chunks); substantially exceeds the budget |
| First visible narration from narration-request start | 5,929 ms | 10,039 ms | <= 3,000 ms | Miss |

Sample: 30 iterations; cache hints were not requested, but provider-side caching could not be disabled or observed. No tool loop was exercised. This local result is engineering evidence only and does not establish the hosted-reference SLO.

**Reference result:** not determined. No hosted reference endpoint configuration is available in the operator database, so no reference pass/miss is claimed.
