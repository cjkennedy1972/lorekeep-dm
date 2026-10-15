# M3-30 latency report: uncached first token with classifier on

Status: **BLOCKED. No measurements taken.** No numbers are reported here.

Base: origin/main at c422514 (feat(memory): registry turn linkage for rewind, #194).

## What was checked

- `MODERATION_PROBE_URL` and `MODERATION_PROBE_MODEL` (required by `apps/server/scripts/moderation-probe.mjs`) are unset in this environment. No LLM endpoint is configured in `.env.example`, the process environment, or the shell config.
- A credential file exists at `~/.lorekeep-llm-key`. It has no base URL or model name, so it cannot identify a reference endpoint. It was not read into this report or committed.
- ADR-013 lists "which endpoint is the reference configuration for SLOs" as an open human decision (`Needs human? Yes`). The spec does not name the endpoint either.

## What is needed to run M3-30

1. The reference `moderate` endpoint: base URL (OpenAI-compatible, `https`), model name, and confirmation that it is the reference configuration.
2. The `fast` (narration) endpoint for the same reference configuration, so first-token time includes narration as well as the judge.
3. The API key, supplied through an env var named in `MODERATION_PROBE_KEY_VAR`, or the operator config path in `docs/operator-guide.md` section 2.
4. Owner decision on the target. ADR-023 revised the first-token budget from 2.5 s to **<= 3 s** (architecture §9.1 allowance), while the M3-30 card states 2.5 s. This report uses the card's 2.5 s until the owner confirms which applies.

## Measurement plan (not yet run)

- N >= 30 uncached runs, with prompt caching disabled, classifier on.
- Time separately: input moderation (target <= 0.4 s), output gate (target <= 0.5 s), first narration token (target <= 2.5 s).
- Report p50 and p95 for each component. State pass or miss against each target.
- Harness: `pnpm --filter @game/server moderation:probe` for the judge alone. A full first-token harness is not in the repo yet and would need to be written before the runs.

## Result

Pass/miss: **not determined.** No run was executed, so no pass or miss is claimed.
