# Start-combat live probe (2026-10-28)

## Setup

- Baseline checkout: `d40997d04a4dc21adec9a111df063e785bca41c8` (`origin/main`).
- Model: `qwen3.8-35b-a3b-distill-q4`; operator-configured local OpenAI-compatible endpoint profile `local-qwen35` (endpoint address intentionally omitted). The API key was read from `~/.lorekeep-llm-key` into `LLM_API_KEY`; it was not printed or persisted.
- Runner: `packages/evals/scripts/start-combat-reliability.mjs`. The probe used the same 20 seeded hostile-action prompts and 20 seeded scene-entry prompts in baseline and retry passes.
- The runner calls the model directly with authored tool schemas. It retains aggregate counts only; no prompts, responses, reasoning, or credentials are recorded. The retry pass is capped at one retry per case.

## Results

| Scenario | Baseline | With structured retry | Change |
|---|---:|---:|---:|
| Hostile-action `start_combat` | 4/20 (20%) | 11/20 (55%) | +35 pp |
| Scene-entry `start_combat` | 1/20 (5%) | 3/20 (15%) | +10 pp |

Retry counts were 13/20 hostile-action and 19/20 scene-entry cases. In each category, the after numerator counts a valid call made either on the initial completion or the single retry.

## Interpretation and limits

These are controlled-probe results, not production-play measurements. Scene-entry starts remain low (3/20), and the results do not establish reliable live play. The probe exercises the live model and server-authored retry affordances, but it is not an end-to-end production Room/database playtest and does not reproduce the full assembled production prompt or state transitions. `combatLikeNarrationsWithoutStart` is a narrow keyword counter included for diagnosis, not a semantic classifier or acceptance metric.

Scene-progression retry is not part of the implementation: it was removed because the probe lacked a negative control showing that ordinary turns do not trigger an unnecessary retry or premature `close_scene` call. No scene-progression measurement in the earlier probe is evidence for shipping that behavior.

The independent R3d playtest remains relevant: at SHA `d40997d04a4dc21adec9a111df063e785bca41c8`, its 8 story rounds produced no `CombatStarted` event. That result and this controlled probe answer different questions and should not be conflated.

## Reproduction

```sh
LLM_API_KEY="$(cat ~/.lorekeep-llm-key)" \
LLM_ALLOW_LOCAL_HOSTS="$OPERATOR_CONFIGURED_LLM_HOST:8080" \
LLM_BASE_URL="$OPERATOR_CONFIGURED_ENDPOINT" node packages/evals/scripts/start-combat-reliability.mjs
```

Set `EVAL_RETRY=1` for the single structured retry pass. Set `EVAL_SCENE=hostile-action` or `EVAL_SCENE=scene-entry` to run only that combat-start batch. Set `EVAL_OUT=/path/to/aggregate.json` to preserve a mode-0600 aggregate record. `swift-qwen3.8-27b` was not run.
