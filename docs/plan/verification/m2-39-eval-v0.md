# M2-39 Eval harness v0: qualification record

Run offline: `pnpm eval:v0` (CI: `llm-recorded` job). Package: `packages/evals`. Qualification logic: `apps/server/src/llm/qualification.ts`.

## Status: live qualification is NOT done

No real LLM key or endpoint was available. The only run is **recorded mode against synthetic fixtures** (`packages/evals/data/recorded.json`), authored by `scripts/build-data.mjs` to validate the harness, not model output. It proves the plumbing and scorers, not any model's quality. No endpoint is qualified by this work. A recorded record carries `mode: "recorded"` and `isQualified` ignores it by design.

To qualify an endpoint (needs a human with an endpoint):

```
LLM_ALLOW_LOCAL_HOSTS=localhost EVAL_API_KEY=... pnpm --filter @game/evals eval:v0 -- --live \
  --base-url http://localhost:11434/v1 --model <model> --profile <endpoint profile id> --seed 1
```

The record is written to `eval-records/<profile id>.json` (git-ignored). `isQualified(profile, records)` is true only for a passing **live** record whose `endpointProfileId` equals the profile id and a tool-capable profile. The live path itself is tested against a local fake OpenAI-compatible server only.

## Recorded-fixture result (seed 1)

| Suite | Metric | Score | n | Threshold | Result |
| --- | --- | --- | --- | --- | --- |
| rules (R-R3) | correct SRD citation + answer | 1.000 | 50 | >= 0.90 | PASS |
| puppeting (R-N3) | flagged rate | 0.000 | 50 | < 0.02 | PASS |
| mapContradiction (R-N5) | flagged rate | 0.000 | 30 | < 0.02 | PASS |
| toolValidity | schema-valid call rate | 1.000 | 20 | >= 0.95 | PASS |

The deliberately bad fixture (`recorded-failing.json`) fails all four suites (tested).

## Method and caveats

- **Dataset sizes are too small for statistical claims.** 50 puppeting turns resolve in steps of 2%, so the < 2% threshold means zero flags; 30 combat turns resolve in steps of 3.3%. Thresholds are initial targets (spec A10, m2-overview Q4), not validated. Spec targets 100 rules questions and 200 puppeting turns; v0 is half or a quarter of that.
- Rules: 50 questions, each with 3 SRD 5.2.1 excerpts (1 correct, 2 seeded distractors); correct = cites the right chunk id and contains the answer keywords. Citations are verified against `packages/engine/srd-text/chunks.json` by test. Keyword matching is a coarse proxy for correctness.
- Puppeting: regex over second-person/PC-name thought and action verbs, excluding verbs the player stated. Heuristic; will miss paraphrase and may flag legitimate text.
- Map contradictions: three checks only (dead combatant acts, false adjacency claim, monster named that is not on the map). Not an LLM judge.
- Tool validity: reply must be JSON `{name, arguments}` for the expected tool and satisfy its schema; schemas forbid extra properties, so supplying coordinates fails.
- Fixed seed: each case gets an FNV-derived seed from the run seed, sent to live endpoints with temperature 0 (endpoint support for `seed` varies; determinism is best effort live, exact in recorded mode).
- Thresholds are duplicated in `qualification.ts` and `packages/evals/data/thresholds.json`; a test fails on drift.
- Not built: persisting records in Postgres or exposing `qualified` through the operator API (`probeEndpoint` still returns `qualified: false`; `withQualification` is the hook). Consistency, red-team and spotlight suites (spec R-L4) are out of scope for v0.
