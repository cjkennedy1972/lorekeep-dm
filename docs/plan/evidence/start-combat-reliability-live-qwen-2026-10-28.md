# Start-combat and scene-advance live probe (2026-10-28)

## Setup

- Baseline checkout: `d40997d04a4dc21adec9a111df063e785bca41c8` (`origin/main`).
- Model: `qwen3.8-35b-a3b-distill-q4`; operator-configured local OpenAI-compatible endpoint profile `local-qwen35` (endpoint address intentionally omitted; use the operator-configured endpoint). The API key was read from `~/.lorekeep-llm-key` into `LLM_API_KEY`; it was not printed or persisted.
- Runner: `packages/evals/scripts/start-combat-reliability.mjs`. Both passes used the same 20 seeded hostile-action prompts and 20 seeded scene-entry prompts. Scene advancement used a separate 20-case set where server-authored context explicitly stated that the objective was complete, the party was leaving, and `scene-next` was the only eligible destination.
- The runner calls the model directly with the authored tool schemas. It retains aggregate counts only; no prompts, responses, reasoning, or credentials are recorded. Retries are enabled only in the after pass and are capped at one per case.

## Results

| Scenario | Baseline | With structured retry | Change |
|---|---:|---:|---:|
| Hostile-action `start_combat` | 4/20 (20%) | 11/20 (55%) | +35 pp |
| Scene-entry `start_combat` | 1/20 (5%) | 3/20 (15%) | +10 pp |
| Completed-scene `close_scene` with correct `nextSceneId` | 17/20 (85%) | 20/20 (100%) | +15 pp |

Retry counts were 13/20 hostile-action, 19/20 scene-entry, and 20/20 completed-scene cases. In each category, the after numerator counts a valid call made either on the initial completion or the single retry.

## Interpretation and limits

The 55% hostile-action and 15% scene-entry rates are controlled-probe results, not production-play measurements. The retry improved all three rates in this controlled probe, but scene-entry starts remain low (3/20); scene-progression retry ships disabled by default until a negative-control measurement exists; this is not evidence that live play is reliable yet. The probe exercises the live model and the same server-authored retry instruction/tool affordances, but it is not an end-to-end production Room/database playtest and does not reproduce the full assembled production prompt or state transitions. In particular, the scene-advance cases explicitly supplied completed-objective/leave context; they do not measure the model's ability to infer completion during a long story. `combatLikeNarrationsWithoutStart` is a narrow keyword counter included for diagnosis, not a semantic classifier or acceptance metric.

The independent R3d playtest remains relevant: at SHA `d40997d04a4dc21adec9a111df063e785bca41c8`, its 8 story rounds produced no `CombatStarted` event. That result and this controlled probe answer different questions and should not be conflated.

## Reproduction

```sh
LLM_API_KEY="$(cat ~/.lorekeep-llm-key)" \
LLM_ALLOW_LOCAL_HOSTS="$OPERATOR_CONFIGURED_LLM_HOST:8080" \
LLM_BASE_URL="$OPERATOR_CONFIGURED_ENDPOINT" node packages/evals/scripts/start-combat-reliability.mjs
```

Set `EVAL_RETRY=1` for the single structured retry pass. Set `EVAL_SCENE=scene-advance` to run only the scene-advance batch. Set `EVAL_OUT=/path/to/aggregate.json` to preserve a mode-0600 aggregate record. `swift-qwen3.8-27b` was not run.
