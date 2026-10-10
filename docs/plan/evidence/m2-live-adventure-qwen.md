# M2 live evidence: Adventure #1 solo turns on local qwen

Run started 2026-10-10T04:01:01.292Z. Endpoint: `http://172.31.25.75:8080/v1` (local stand-in; not the hosted reference endpoint). Model: `qwen3.8-35b-a3b-distill-q4`. Tool mode: native (per the probe record in `docs/plan/m2-proof-report.md`).

Adventure `adventure:01-hollow-under-marrowfell`, start scene `scene-marowfell-well`. Character: `class:cleric` level 1 (quickBuild, seed 0x28), actor id scrubbed to a random UUID. Runner: `ProductionSoloTurnRunner` with a real `OpenAICompatibleAdapter` (stream timeout 180000 ms; production default is 12000 ms). maxTokens: production values (512 first request, 400 after tool results, set in `orchestrator.ts`).

Model calls this run: 18 (budget 60). Credential supplied via env only; not recorded. Scratch database and fixture directory were discarded.

## Summary

| # | Player input (id) | DM calls | Summary calls | Tool calls requested | Rejected | Rolls | close_scene | Scene before -> after | Fallback | Out tokens | Wall ms | Error |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | I look around the well. What do I see here? (look) | 1 | 0 | 0 | 0 | 0 | no | scene-marowfell-well -> scene-marowfell-well | - | 432 | 6012 | - |
| 2 | I walk up to the hooded figure beside the well and ask what happened to the village. (talk) | 3 | 0 | 2 (close_scene, upsert_npc) | 2 | 0 | no | scene-marowfell-well -> scene-marowfell-well | - | 1053 | 12620 | - |
| 3 | I search the stonework for a hidden inscription. Please call for a Perception check. (check) | 4 | 0 | 4 (request_check, request_check, apply_condition, request_check) | 4 | 0 | no | scene-marowfell-well -> scene-marowfell-well | no-narration | 1012 | 11140 | - |
| 4 | I lower myself down into the well shaft and listen for anything below. (descend) | 5 | 0 | 5 (request_check, request_check, request_check, request_check, request_check) | 5 | 0 | no | scene-marowfell-well -> scene-marowfell-well | budget-exhausted | 1343 | 14999 | - |
| 5 | We are done here. Let's move on to the next place. (close-1) | 1 | 0 | 0 | 0 | 0 | no | scene-marowfell-well -> scene-marowfell-well | - | 252 | 3288 | - |
| 6 | I look around the broken gatehouse. Who or what is here? (gatehouse) | 2 | 0 | 1 (upsert_location) | 1 | 0 | no | scene-marowfell-well -> scene-marowfell-well | - | 804 | 9423 | - |
| 7 | I ask the gatekeeper's ghost about the bell in the chapel. (ghost) | 1 | 0 | 0 | 0 | 0 | no | scene-marowfell-well -> scene-marowfell-well | - | 512 | 5969 | - |
| 8 | We are done here, move on. (close-2) | 1 | 0 | 19 (close_scene, close_scene, close_scene, close_scene, close_scene, close_scene, close_scene, close_scene, close_scene, close_scene, close_scene, close_scene, close_scene, close_scene, close_scene, close_scene, close_scene, close_scene, close_scene) | 5 | 0 | no | scene-marowfell-well -> scene-marowfell-well | budget-exhausted | 512 | 3903 | - |

## Analysis

Single run, single model, 8 player turns, 18 model calls, no timeouts or endpoint errors. This is evidence of behavior in one session, not a rate.

- **Valid tool calls: 0 of 31.** Every requested tool call (close_scene, upsert_npc, request_check, apply_condition, upsert_location) was emitted with empty arguments (`{}`) and rejected with `schema-violation`. No scene closed, no roll resolved, and no NPC or location was stored. The likely cause is product bug (a): `productionTurnRunner.ts` passes `runTurn` no `toolSchemas`/`toolDescriptions`, so `orchestrator.ts:143` sends `parameters: {}` in the native tools array. The schemas are present only as text in the system prompt, and the model did not use them. This is a hypothesis from the code path; it has not been tested by changing the runner.
- **Narration: readable and grounded.** Turns 1, 2, 5, 6 and 7 used authored names and facts (Nessa Kell, Gallows Knoll, Tallow Hold, Ember Lamp, the kennel glow) and no reasoning text appeared in visible narration. Turns 6 and 7 were cut mid-sentence: their output hit exactly `maxTokens=512`, and `openai.ts` does not check `finish_reason`, so truncation is silent (product bug b).
- **Fallback text shown as narration.** Turns 3, 4 and 8 ended in a fallback, and the player saw the canned line "Nothing comes of the attempt. What do you do?" (`orchestrator.ts:372`) as if it were narration. Failures are hidden from the player in this way; they should be surfaced as failures.
- **close_scene: no successful close in the run.** Turn 2 (no request to leave) produced a rejected `close_scene`. Turn 5 asked to move on: the model called no tool and narrated the party walking toward the gatehouse, but state stayed at `scene-marowfell-well`, so narration and state disagree. Turn 8 asked to move on: the model emitted 19 `close_scene` calls in one response; the orchestrator reported 5 `ToolCallRejected` events and then a `budget-exhausted` fallback. The other 14 are not individually reported by the events and the orchestrator's handling of them was not verified here.
- **Budget and fallbacks:** 3 fallbacks in 8 turns (`no-narration` x1, `budget-exhausted` x2). Turn 4 used 5 calls for 5 rejected `request_check` calls before the budget ran out.
- **Latency:** time to first token 1.2 to 5.0 s; slowest single call 6.0 s; slowest turn 15.0 s over 5 calls. The production default of 12 s per call was not reached in this run; the 180 s timeout used here was not needed. The default timeout covers the whole stream per call.
- **Usage:** 70,011 input tokens and 5,920 output tokens across 18 calls. The harness counted these from the adapter stream; `MeteredLlmAdapter` is bypassed when an adapter override is used.
- **Reasoning leakage:** none seen in the visible narration text.

Product bugs to report in the PR body (not fixed here): (a) native tools sent with empty `parameters` and no toolDescriptions, so the model emits empty arguments; (b) hardcoded 512/400 output caps with no `finish_reason` check, so narration truncates silently; (c) fallback text is delivered as narration rather than flagged as a failure; (d) the model returned 19 tool calls in one response (turn 8); how the orchestrator's `MAX_TOOL_CALLS=8` limit handled them was not verified.

## Turns

### Turn 1: look

Player: I look around the well. What do I see here?

Narration (as delivered by the orchestrator):

> You step up to the well-head and let your eyes adjust. The stone ring is old, slick with damp, and ringed with a dozen dead lamps whose glass housings are cracked and blackened. Beyond the rim, the well drops into absolute dark, carrying up a breath of cold, metallic air that tastes faintly of tallow and copper.
> 
> To the west, the flagged yard slopes down toward a leaning gate tower. Rubble spills across the stones, and in the shadows of the kennel beyond, a faint ember-glow pulses like a slow heartbeat.
> 
> To the east, the dead lamps cast nothing but your own shadow against the well's stone. The water below is still, but the surface seems wrong—too dark, too thick, as though something beneath has soured the well's heart.
> 
> Nessa Kell stands at your shoulder, her hood pulled low. "The water turned bitter three nights ago," she says quietly. "Before that, the Ember Lamp in the kennel burned clean. Now it sputters. Something's wrong down there."
> 
> The dead lamps around the well-head feel like a warning—or a failed attempt to keep something out.
> 
> What do you do next?

Fallback: none. Scene: scene-marowfell-well -> scene-marowfell-well. Turn usage in/out: 3116/432.

- call dm: maxTokens=512, in=3116, out=432, ttft=2779 ms, latency=5975 ms, visible text chars=1075
- events: TurnStartedx1, TurnCommittedx1

### Turn 2: talk

Player: I walk up to the hooded figure beside the well and ask what happened to the village.

Narration (as delivered by the orchestrator):

> Nessa Kell pulls her hood back, revealing a face etched with exhaustion and something sharper — fear, or perhaps guilt. She gestures toward the village with a gloved hand.
> 
> "The village didn't burn. It *left.*" Her voice is low, measured. "Three nights ago, the well turned bitter. Before that, the Ember Lamp in the kennel burned clean and steady. Now it sputters. And by morning, every soul who'd slept within the knoll's shadow was gone — coats still on pegs, bread still warm on tables. No signs of struggle. No tracks in the snow."
> 
> She turns back to the well, her face pale in the dead lamp-light. "The elders said the Tallow Hold beneath Gallows Knoll was sealed centuries ago, but the water remembers what the stone forgets. If something woke down there, it's still down there. And the lamp's ember-glow in the kennel... that's all that's keeping it from climbing up."
> 
> She meets your gaze, her eyes reflecting the faint red pulse from the kennel shadows. "Will you go down, or will you let the cold take the rest of us?"
> 
> The wind picks up, carrying the faint metallic tang of tallow and copper from the well's throat.

Fallback: none. Scene: scene-marowfell-well -> scene-marowfell-well. Turn usage in/out: 13371/1053.

- call dm: maxTokens=512, in=4241, out=410, ttft=2128 ms, latency=5697 ms, visible text chars=1077
  - tool requested: `close_scene` {}
- call dm: maxTokens=512, in=4536, out=267, ttft=3459 ms, latency=3459 ms, visible text chars=0
  - tool requested: `upsert_npc` {}
- call dm: maxTokens=512, in=4594, out=376, ttft=1356 ms, latency=3433 ms, visible text chars=1127
- tool rejected: `close_scene` error=schema-violation attempt=1
- tool rejected: `upsert_npc` error=schema-violation attempt=1
- events: TurnStartedx1, ToolCallRejectedx2, TurnCommittedx1

### Turn 3: check

Player: I search the stonework for a hidden inscription. Please call for a Perception check.

Narration (as delivered by the orchestrator):

> Nothing comes of the attempt. What do you do?

Fallback: no-narration. Scene: scene-marowfell-well -> scene-marowfell-well. Turn usage in/out: 17876/1012.

- call dm: maxTokens=512, in=4327, out=192, ttft=2832 ms, latency=2832 ms, visible text chars=0
  - tool requested: `request_check` {}
- call dm: maxTokens=512, in=4406, out=171, ttft=1879 ms, latency=1880 ms, visible text chars=0
  - tool requested: `request_check` {}
  - tool requested: `apply_condition` {}
- call dm: maxTokens=512, in=4530, out=137, ttft=1598 ms, latency=1598 ms, visible text chars=0
  - tool requested: `request_check` {}
- call dm: maxTokens=512, in=4613, out=512, ttft=n/a ms, latency=4779 ms, visible text chars=0
- tool rejected: `request_check` error=schema-violation attempt=1
- tool rejected: `request_check` error=schema-violation attempt=2
- tool rejected: `apply_condition` error=schema-violation attempt=1
- tool rejected: `request_check` error=schema-violation attempt=3
- events: TurnStartedx1, ToolCallRejectedx4, TurnFallbackx1, TurnCommittedx1

### Turn 4: descend

Player: I lower myself down into the well shaft and listen for anything below.

Narration (as delivered by the orchestrator):

> Nothing comes of the attempt. What do you do?

Fallback: budget-exhausted. Scene: scene-marowfell-well -> scene-marowfell-well. Turn usage in/out: 17322/1343.

- call dm: maxTokens=512, in=3304, out=461, ttft=5033 ms, latency=5033 ms, visible text chars=0
  - tool requested: `request_check` {}
- call dm: maxTokens=512, in=3383, out=182, ttft=2215 ms, latency=2215 ms, visible text chars=0
  - tool requested: `request_check` {}
- call dm: maxTokens=512, in=3462, out=370, ttft=4121 ms, latency=4121 ms, visible text chars=0
  - tool requested: `request_check` {}
- call dm: maxTokens=512, in=3545, out=195, ttft=2005 ms, latency=2005 ms, visible text chars=0
  - tool requested: `request_check` {}
- call dm: maxTokens=512, in=3628, out=135, ttft=1569 ms, latency=1569 ms, visible text chars=0
  - tool requested: `request_check` {}
- tool rejected: `request_check` error=schema-violation attempt=1
- tool rejected: `request_check` error=schema-violation attempt=2
- tool rejected: `request_check` error=schema-violation attempt=3
- tool rejected: `request_check` error=schema-violation attempt=4
- tool rejected: `request_check` error=schema-violation attempt=5
- events: TurnStartedx1, ToolCallRejectedx5, TurnFallbackx1, TurnCommittedx1

### Turn 5: close-1

Player: We are done here. Let's move on to the next place.

Narration (as delivered by the orchestrator):

> You climb back up from the well shaft, brushing the damp grit from your hands. The dead lamps around the well-head offer no answers; the bitter water remains bitter. Nessa Kell watches you return, her expression unreadable.
> 
> You turn your back on the well and press onward toward the only path that leads deeper into Marrowfell.
> 
> The path narrows and slopes downward, the air growing cold and smelling of wet stone and tallow. Ahead, a leaning gate tower rises from a tangle of rubble, its archway dark and gaping. Through the broken stonework, a faint ember-glow pulses in the kennel beyond — warm, alive, and wrong. The gatehouse blocks your way, but the rubble offers a way in.
> 
> What do you do?

Fallback: none. Scene: scene-marowfell-well -> scene-marowfell-well. Turn usage in/out: 3279/252.

- call dm: maxTokens=512, in=3279, out=252, ttft=1231 ms, latency=3236 ms, visible text chars=697
- events: TurnStartedx1, TurnCommittedx1

### Turn 6: gatehouse

Player: I look around the broken gatehouse. Who or what is here?

Narration (as delivered by the orchestrator):

> You crest the slope and the broken gatehouse fills your view. A leaning gate tower rises from a tangle of rubble across a flagged yard, its stonework cracked and dark. Cold air rolls out, thick with the smell of tallow and wet stone. Through the broken stonework you can see into a kennel beyond—a faint ember-glow pulses there, warm and alive and wrong. The gatehouse blocks the path forward, but the

Fallback: none. Scene: scene-marowfell-well -> scene-marowfell-well. Turn usage in/out: 7818/804.

- call dm: maxTokens=512, in=3880, out=292, ttft=3800 ms, latency=3800 ms, visible text chars=0
  - tool requested: `upsert_location` {}
- call dm: maxTokens=512, in=3938, out=512, ttft=4547 ms, latency=5590 ms, visible text chars=401
- tool rejected: `upsert_location` error=schema-violation attempt=1
- events: TurnStartedx1, ToolCallRejectedx1, TurnCommittedx1

### Turn 7: ghost

Player: I ask the gatekeeper's ghost about the bell in the chapel.

Narration (as delivered by the orchestrator):

> You call out to the spectral figure lingering near the collapsed gate tower. The ghost's jaw works silently, then a voice like wind through a cracked bell answers:
> 
> *"The well did not turn bitter on its own. Something in the Tallow Hold—the old burial chamber beneath Gallows Knoll—has been drinking the Ember Lamp's light. The water remembers what the lamp forgets."*
> 
> It gestures with a translucent hand toward the kennel's ember-glow. *"The lamp still burns

Fallback: none. Scene: scene-marowfell-well -> scene-marowfell-well. Turn usage in/out: 3606/512.

- call dm: maxTokens=512, in=3606, out=512, ttft=4671 ms, latency=5947 ms, visible text chars=460
- events: TurnStartedx1, TurnCommittedx1

### Turn 8: close-2

Player: We are done here, move on.

Narration (as delivered by the orchestrator):

> Nothing comes of the attempt. What do you do?

Fallback: budget-exhausted. Scene: scene-marowfell-well -> scene-marowfell-well. Turn usage in/out: 3623/512.

- call dm: maxTokens=512, in=3623, out=512, ttft=3872 ms, latency=3872 ms, visible text chars=0
  - tool requested: `close_scene` {}
  - tool requested: `close_scene` {}
  - tool requested: `close_scene` {}
  - tool requested: `close_scene` {}
  - tool requested: `close_scene` {}
  - tool requested: `close_scene` {}
  - tool requested: `close_scene` {}
  - tool requested: `close_scene` {}
  - tool requested: `close_scene` {}
  - tool requested: `close_scene` {}
  - tool requested: `close_scene` {}
  - tool requested: `close_scene` {}
  - tool requested: `close_scene` {}
  - tool requested: `close_scene` {}
  - tool requested: `close_scene` {}
  - tool requested: `close_scene` {}
  - tool requested: `close_scene` {}
  - tool requested: `close_scene` {}
  - tool requested: `close_scene` {}
- tool rejected: `close_scene` error=schema-violation attempt=1
- tool rejected: `close_scene` error=schema-violation attempt=2
- tool rejected: `close_scene` error=schema-violation attempt=3
- tool rejected: `close_scene` error=schema-violation attempt=4
- tool rejected: `close_scene` error=schema-violation attempt=5
- events: TurnStartedx1, ToolCallRejectedx5, TurnFallbackx1, TurnCommittedx1

