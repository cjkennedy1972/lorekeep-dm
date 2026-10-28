# ADR-038 verification commands

The authored encounter affordance is disabled by default. Set
`LOREKEEP_ADR_038_STORY_COMBAT=true` only in a development or isolated smoke
process until rollout is approved. The server accepts only the authored
`encounterId`; encounter rosters and map data remain server-derived.

## Production-route regression

Run the deterministic route regression against the Docker-backed disposable
Postgres database (never a shared or production database):

```sh
DATABASE_URL="$ADR038_TEST_DATABASE_URL" \
  pnpm --filter @game/server exec vitest run --no-file-parallelism \
  test/db/combat.test.ts \
  -t 'validates authored encounter keys through the production turn route'
```

This test sends turns through the real `ProductionSoloTurnRunner` and checks a
valid current-scene key, a cross-scene rejection with no combat-state mutation,
and that a scene with no declared encounters omits `start_combat` from the
prompt. It uses a deterministic adapter; it does not contact an LLM endpoint.

## Live Adventure 01 transcript smoke

For the optional local-model transcript runner, first build the workspaces and
migrate an isolated database. Supply the endpoint key through the environment;
never put it in the command text or evidence file:

```sh
LIVE_LLM=1 \
LOREKEEP_ADR_038_STORY_COMBAT=true \
DATABASE_URL="$ADR038_TEST_DATABASE_URL" \
LLM_API_KEY="$LLM_API_KEY" \
LLM_ALLOW_LOCAL_HOSTS=172.31.25.75:8080 \
pnpm --filter @game/server exec vitest run \
  -c test/live/vitest.adventure-transcript.live.config.ts
```

The transcript runner is a live-model exploration smoke, not proof of the full
combat transition. For the combat acceptance smoke, use a development table on
Adventure 01 with the flag enabled and provoke the warren-gallery encounter.
Within five player attempts, verify that the server commits `CombatStarted`,
`combatRoom.map`, and initiative from the combat executor; opening narration is
emitted once; the held-opening fallback, if triggered, includes only each
viewer’s projected summary; and persisted events and logs contain no player
text or roster secrets. Check both an ordinary seat and the controller of a
hidden monster. Do not run this live smoke as part of CI.
