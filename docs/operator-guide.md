# Operator guide: LLM endpoints, recorded-LLM replay, tests, SRD attribution

For the person running a Lorekeep-DM server. Background: [ADR-013](adr/013-llm-provider-adapter-tool-fallback.md), [ADR-012](adr/012-eval-strategy.md), [endpoint egress runbook](security/m2-endpoint-egress.md). Placeholders such as `<your-key>` are never real values; do not paste real keys into docs, tickets, or shell history you share.

Party play (M4) operator and player behavior, including what is not shipped yet, is in [operator/party-play.md](operator/party-play.md).

## 1. Server environment

"Production" below means `NODE_ENV` is unset or anything other than `development` or `test`. An unset `NODE_ENV` is production, so the boot checks fail closed.

| Variable | Required in production | Default | Missing or invalid in production | Notes |
| --- | --- | --- | --- | --- |
| `NODE_ENV` | Set to `production` (or leave unset) | `production` | Only `development`, `test`, `production` are accepted; anything else fails config load. | `development`/`test` enable the dev-only fallbacks below. Never set them on a production host. |
| `DATABASE_URL` | Yes | none | Config load fails. | Run `pnpm --filter @game/server migrate:up` before the first boot. |
| `HOST` | No | `0.0.0.0` | Any string. | Use `127.0.0.1` when the proxy runs on the same host. See the proxy sample below. |
| `PORT` | No | `3000` | Outside 1 to 65535 fails config load. | The app port must be reachable only through the proxy. |
| `TRUST_PROXY` | Yes when behind a proxy | `false` | Must be `true`, `false`, a hop count, or a comma-separated list of proxy IPs or CIDRs; anything else fails config load. | Use a hop count for one reverse proxy on the same host: `1` (`0` means `false`). The app then takes the address the proxy recorded, and a client-supplied leftmost `X-Forwarded-For` entry is ignored. Use a CIDR or IP list (e.g. `10.0.0.0/8`) to trust forwarded headers only from those proxy addresses. `true` trusts every hop and lets any client that reaches the app choose its own address. The proxy must overwrite `X-Forwarded-For` (the sample does). With `false` behind a proxy, all clients share the proxy's IP and one rate-limit bucket. Note: `1` now means one hop, not boolean true. |
| `AGE_RETRY_SECRET` | Yes | `development-only-secret` in development/test only | `AGE_RETRY_SECRET is required` at boot. | Signs the session cookie and age-gate cookie. Generate with `openssl rand -hex 32`. |
| `OPERATOR_EMAILS` | Yes, non-empty | empty (nobody is an operator) | Boot fails with `Operator configuration is required`. | Comma-separated. Everyone else gets `404 NOT_FOUND` on `/api/operator/*`. |
| `OPERATOR_ENDPOINT_MASTER_KEY` | Yes | none; development/test use a fixed development key | Boot fails with `Operator configuration is required`; the first endpoint use throws `Endpoint encryption key unavailable`. | AES-256-GCM key: 32 bytes as 64 hex or base64, or a keyring `id:key,id:key`. Generate with `openssl rand -hex 32`. Store it in your secret manager. |
| `OPERATOR_ENDPOINT_ACTIVE_KEY_ID` | No | last keyring entry | n/a | Keyring entry used for new writes. |
| `RESEND_API_KEY`, `EMAIL_FROM`, `APP_BASE_URL` | All three, or none in development/test | none | Partial set fails boot. None set in production fails boot. | `EMAIL_FROM` is e.g. `Lorekeep <noreply@your-domain>` and its domain must be verified in Resend. `APP_BASE_URL` must be a full URL (e.g. `https://lorekeep.example`); links are `<APP_BASE_URL>/verify?token=…` and `/reset?token=…`. The key is never logged. In development/test, missing email config uses a console sender that logs only that delivery is not configured. |
| `LLM_ALLOW_LOCAL_HOSTS` | No | empty | Endpoints on loopback/private hosts, or with plain `http`, are rejected on save and probe. | Comma-separated exact hosts (e.g. a local model). Section 2. |
| `SOLO_TURN_ENDPOINT_SLOT` | No | `fast` | Must be `fast`, `frontier`, or `moderate`. | Endpoint slot used for solo turns. |
| `LIVE_DM_ALLOWLIST_ONLY` | No | `true` | Must be `true` or `false`; anything else fails config load. | M3 gate. While `true`, a live (non-recorded) DM turn from an account not in `OPERATOR_EMAILS` (or not active) is rejected with `LIVE_DM_RESTRICTED` and no model call is made. Resume recaps for such accounts use the deterministic recap with no model call. Recorded fixture mode is not gated. `NODE_ENV=test` disables the gate: never set it in production. The server logs a warning at boot if `NODE_ENV=test`, the gate is on, and `DATABASE_URL` is not local. The allowlist is checked on every turn, but `OPERATOR_EMAILS` is read from the environment, so change it and restart. Set `false` only at M3 exit (M3-33), once moderation has landed. |
| `LLM_FIXTURE_MODE` | Must be unset | unset (live endpoint) | `strict` is the only allowed value in production; `lenient`/`record` fail boot, and unknown values fail. | Recorded-LLM replay, section 4. |
| `LLM_FIXTURE_PATH` | No | `fixtures/solo-turn.ndjson` | Read only when fixture mode is set. | Section 4. |
| `SWEEP_INTERVAL_MS` | No | `3600000` | Non-integer or negative fails config load. | `0` disables the retention sweeper. |
| `ROOM_DRAIN_DEADLINE_MS` | No | `30000` | Non-integer or negative fails config load. | Shutdown stops waiting for in-flight turns after this many milliseconds and releases the room lease; `0` gives up immediately. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | No | unset (no exporter) | Invalid URL fails config load. | OTLP trace export. |
| `EXPORT_ARCHIVE_DIR` | Yes, set explicitly | `/tmp/lorekeep-exports` | Not in the config schema. Nothing refuses the `/tmp` default. | Export archives are written here (0700 directory, 0600 files). `/tmp` is not acceptable for production data. Card 1ada4844 tracks a production refusal. |
| `WS_ALLOWED_ORIGINS` | Only for cross-origin web clients | unset (same-host origins only) | Not in the config schema; read raw. | Comma-separated full origins (e.g. `https://app.example`). A trailing slash or path never matches. |
| `WS_TICKET_ORIGIN_BYPASS_ENABLED` | No | `false` | `false` or `true`. | When `true`, origins listed in `WS_ALLOWED_ORIGINS` may bypass the same-origin check when requesting `POST /api/ws-ticket`. Keep disabled unless cross-origin clients need ticket creation. |
| `LOREKEEP_ADR_038_STORY_COMBAT` | No | `false` | Must be `true` to enable; any other value (including unset) leaves it off. | ADR-038 authored story-to-combat. When `true`, the exploration DM may call `start_combat` with an authored encounter key for the current scene. Off by default; enable only in development or an isolated smoke process until rollout is approved. Read in `apps/server/src/room/productionTurnRunner.ts`. |
| `LLM_API_KEY` | Do not set | none | Parsed and redacted, but no server code path reads it. | Endpoint keys are stored per slot (encrypted), not from this variable. |

`POST /api/ws-ticket` checks the `Origin` header. By default, the origin must match the request's scheme and host (`apps/server/src/middleware/origin.ts`, used by the gateway). `WS_ALLOWED_ORIGINS` does not bypass this check unless `WS_TICKET_ORIGIN_BYPASS_ENABLED=true`. When enabled, an exact listed origin can request WebSocket tickets across origins. The trade-off: a listed origin that is compromised or hostile can request WebSocket tickets from a visitor's browser. List only origins you control and trust, as exact full origins with scheme and port (`https://app.example`). Do not use wildcards: the check is an exact string match, so `*` matches nothing. Do not add a trailing slash or path, because those never match.

Generate a master key locally (output is a secret; put it in your secret manager, not in the repo):

```sh
openssl rand -hex 32
```

### Production behind a reverse proxy

Use nginx: its `proxy_set_header` gives explicit control over `X-Forwarded-For` (overwritten with `$remote_addr`, never appended), the `/ws` upgrade, and per-location timeouts. The sample is [`infra/proxy/lorekeep.nginx.conf`](../infra/proxy/lorekeep.nginx.conf). It is not deployed anywhere; adapt the host name and certificate paths.

- Run the app with `HOST=127.0.0.1`, `PORT=3000`, `TRUST_PROXY=1`, and firewall the app port so only the proxy can reach it. A client that can reach the app port directly can send its own `X-Forwarded-For` and bypass per-IP rate limits whenever the app trusts forwarded headers, so the firewall is required even with a hop count.
- Long LLM turns: HTTP has a 300 s timeout; `/ws` has 3600 s because the connection stays open across turns, and the server pings every 10 s.
- The moderation endpoint's own request timeout MUST be no more than 5 min. A judge connection destroyed after 60 s stops the gate waiting, but the upstream may continue running unobserved until its request timeout.
- Rate-limit buckets live in process memory, so each instance has its own. Running several replicas multiplies the effective limits.
- Session cookies are `__Host-sid` with `Secure` in every non-development run, regardless of `X-Forwarded-Proto`, so a plain-HTTP request to the app still gets a `Secure` cookie.

Smoke test: `DATABASE_URL=postgres://… pnpm --filter @game/server smoke:prod` after `pnpm -r build`. It migrates the database at `DATABASE_URL` (use a scratch database), boots `dist` in production mode with dummy values and a local stub LLM endpoint, and checks `/healthz`, the login cookie with `X-Forwarded-Proto: https`, separate rate-limit buckets for two forwarded addresses, and one solo turn reaching the stub. It exits non-zero on failure and needs no real credentials.

## 2. Configure an endpoint

Endpoints live in three slots: `fast`, `frontier`, `moderate`. All calls need a session cookie for an operator account (log in through the app or save one with `curl -c cookies.txt -X POST http://localhost:3000/api/login -H 'content-type: application/json' -d '{"email":"<operator-email>","password":"<password>"}'`). On a fresh local database, `POST /api/signup` creates a `pending_email` account and the development mail sender never prints the verification token, so activate it directly: `docker exec infra-postgres-1 psql -U lorekeep -c "update accounts set status='active' where email='<operator-email>'"`. Routes:

| Method and path | Effect |
| --- | --- |
| `GET /api/operator/endpoints` | List slots. Never returns the key: only `keySet` and a `keyFingerprint` (`v2:` plus 12 hex, an HMAC keyed by the master key; legacy values are bare 12 hex and are replaced on the next save or test). |
| `PUT /api/operator/endpoints/:slot` | Save the config; returns it with `"probe": null`. Saving does not call the endpoint: run the test route next. |
| `POST /api/operator/endpoints/:slot/test` | Run the probe on the saved config and store the result (shown as `probe` by `GET`). |
| `DELETE /api/operator/endpoints/:slot` | Remove the slot: `200 {"deleted":true}`, or `404 NOT_FOUND` if the slot is empty. A slot other than `fast`, `frontier`, `moderate` returns `400 INVALID_SLOT`. |
| `PATCH /api/operator/sessions/:id/mature-endpoint` | Enable or revoke the per-session mature endpoint grant. Requires technical probes and explicit policy attestation for both the narration and moderation endpoints. |

Body for `PUT` (unknown fields are rejected): `baseUrl`, `model`, `apiStyle` (`openai` or `anthropic`), optional `apiKey` (write-only), `contextWindow`, `unsupportedToolSchemaKeywords` (default `[]`; metadata only today, see the egress runbook).

Config changes apply from the next DM turn; a turn already running finishes on the old config.

### Enable mature content for one session

Mature content stays disabled by default. This operator grant is separate from setting a table's content tier, and the technical probe does **not** establish policy permission. Mature narration is also sent to the moderation classifier, so attest both endpoints:

1. Save and `POST /api/operator/endpoints/:slot/test` the endpoint used for narration (`SOLO_TURN_ENDPOINT_SLOT`, default `fast`).
2. Save and test the `moderate` endpoint used by the content classifier.
3. Review each endpoint's applicable terms/AUP and confirm they permit this product's defined mature tier. Do not grant if either endpoint's policy is unknown or disallows it. The narration endpoint probe must show reachability, streaming, and a supported structured-call mode (the selected mode's capability already encodes its own 95% valid-call threshold). The moderation endpoint probe must show reachability and streaming; its plain-text JSON judge does not need tool-call support.
4. For a session UUID, enable the grant with this exact acknowledgement:

```sh
curl -sS -b cookies.txt -X PATCH "http://localhost:3000/api/operator/sessions/<session-id>/mature-endpoint" \
  -H 'content-type: application/json' \
  -d '{"enabled":true,"policyAcknowledgement":"I_CONFIRM_NARRATION_AND_MODERATION_ENDPOINT_POLICIES_ALLOW_MATURE"}'
```

The API returns `{"enabled":true,"narrationEndpointSlot":"fast","moderationEndpointSlot":"moderate"}` (the narration slot reflects `SOLO_TURN_ENDPOINT_SLOT`). The session grant is bound to the current narration and moderation endpoint configurations; saving or changing either endpoint invalidates that grant, so review both policies and grant it again after changes. It does not raise the table tier. The host must separately select mature, and the usual moderation, age, player opt-out, live-play, and hard-floor checks still apply.

Revoke at any time:

```sh
curl -sS -b cookies.txt -X PATCH "http://localhost:3000/api/operator/sessions/<session-id>/mature-endpoint" \
  -H 'content-type: application/json' \
  -d '{"enabled":false}'
```

### Hosted OpenAI-compatible endpoint

`https` on port 443 only; no `LLM_ALLOW_LOCAL_HOSTS` entry needed. The host must resolve in DNS when you save: the placeholder `api.example.com` below does not resolve and returns `400 INVALID_ENDPOINT_URL`, so substitute your provider's real host.

```sh
curl -sS -b cookies.txt -X PUT http://localhost:3000/api/operator/endpoints/moderate \
  -H 'content-type: application/json' \
  -d '{"baseUrl":"https://api.example.com/v1","model":"example-model","apiStyle":"openai","apiKey":"<your-key>"}'
```

### Local endpoint (Ollama, llama.cpp, vLLM on loopback or a LAN host)

Plain `http` and loopback/private addresses are refused unless the exact host is listed. Start the server with the host allowed:

```sh
pnpm --filter @game/server build
LLM_ALLOW_LOCAL_HOSTS=localhost node apps/server/dist/main.js
```

then save the slot with `"baseUrl":"http://localhost:11434/v1"`, `"apiStyle":"openai"`, `"contextWindow":32768` (without it the probe reports the 32k check as unsupported: `context window not configured`), and no `apiKey` if the server needs none, then `POST .../moderate/test`. A host that is not listed, such as `127.0.0.2` here, returns `400 INVALID_ENDPOINT_URL`. For a LAN host use its exact address (`LLM_ALLOW_LOCAL_HOSTS=172.31.25.75`); there is no subnet wildcard. Cloud metadata addresses (`169.254.169.254` and similar) are blocked even when listed. A disallowed URL returns `400 INVALID_ENDPOINT_URL`.

## 3. Read the probe result

`probe` is an `EndpointProfile` (`apps/server/src/llm/probe.ts`):

| Field | Meaning |
| --- | --- |
| `capabilities.reachability` / `streaming` / `nativeTools` / `jsonSchema` / `contextWindow32k` | Each `{ supported, detail? }`. |
| `toolMode` | `native` (provider tool calls), `json-schema` (fallback), or `unsupported`. |
| `validCallRate`, `schemaViolations` | Aggregate share of synthetic tool calls that were valid across both tool modes, and count that were not. Mature eligibility checks the selected mode's capability flag (which reflects that mode's own 95% threshold), not this aggregate rate. |
| `ttftMs` | Time to first token or tool call. |
| `contextWindow` | Value used for the 32k check. |
| `qualified` | Always `false` from the probe: passing it does not qualify a model. Qualification needs the eval results. |

Save with warnings is allowed. Treat `toolMode: "unsupported"`, `reachability.supported: false`, or a low `validCallRate` as "do not use for DM turns". If the probe call itself fails the test route returns `503 PROBE_FAILED`.

## 4. Recorded-LLM record and replay

A recording is an NDJSON file of prompt hashes and responses (`apps/server/src/llm/recorded.ts`). Replay needs no network or key and streams with no delay.

| `LLM_FIXTURE_MODE` | Behavior |
| --- | --- |
| unset (default) | Live endpoint: no replay, no recording. |
| `strict` | Replay. Any prompt-hash drift throws with expected and actual hashes and tool names; in a live turn the DM falls back to a generic "the storyteller has lost the thread" narration. |
| `lenient` | Replay; drift does not fail the turn (the adapter's `warn` hook reports it, but the server's turn runner does not wire it, so nothing is logged today). |
| `record` | Calls the configured endpoint and appends request hash and response to `LLM_FIXTURE_PATH` (default `fixtures/solo-turn.ndjson`). Requires `NODE_ENV` of `development` or `test`. |

`lenient` and `record` are refused when `NODE_ENV=production`. Recordings redact `Bearer` tokens in text, but review a fixture before committing it. Fixture turn seeds are fixed in fixture modes; real turns draw a 64-bit seed from the OS CSPRNG, and the seed is never put in a prompt.

Workflow:

```sh
# record against the real endpoint saved in the moderate slot
NODE_ENV=development LLM_FIXTURE_MODE=record LLM_FIXTURE_PATH=fixtures/solo-turn.ndjson node apps/server/dist/main.js
# replay
LLM_FIXTURE_MODE=strict LLM_FIXTURE_PATH=fixtures/solo-turn.ndjson node apps/server/dist/main.js
```

A fixture replays only when the prompt is byte-identical. The prompt contains table and character ids, so a fixture recorded on one table drifts on a different one: `strict` then falls back to the generic narration and `lenient` replays the recorded text. Re-record when prompts change intentionally. CI never records.

To trigger the recorded turn on a live server, create a table (`POST /api/tables`), request a ticket (`POST /api/ws-ticket` with `{"sessionId":"<table id>"}`), open `/ws?ticket=<ticket>` and send `{"type":"PlayerAction","actionId":"<uuid>","lastSeq":0,"payload":{"text":"Look at the old door."}}`; the fixture file appears after the first turn. The fixture path is relative to the server's working directory.

## 5. Tests and evals

| Command | What it covers |
| --- | --- |
| `pnpm --filter @game/server test` | Server unit tests, including recorded-LLM, probe, and egress suites (no database). |
| `pnpm --filter @game/server exec vitest run test/dm/recorded.test.ts test/llm/probe.test.ts test/llm/egress.test.ts` | Just those three suites. |
| `pnpm --filter @game/e2e exec vitest run m2-scenarios` | Eight scripted combats replayed against reviewed golden event logs in `tests/e2e/golden/`. |
| `UPDATE_GOLDEN=1 pnpm --filter @game/e2e exec vitest run m2-scenarios` | Regenerate goldens; review the diff before committing. |

**Gap:** [ADR-012](adr/012-eval-strategy.md) describes nightly live-LLM eval suites (rules Q&A, puppeting, consistency, injection, moderation) with release thresholds. No such runner exists in the repo yet, so there is no command to run them and no model can be marked qualified. Deterministic tests above are the only automated gate.

## 6. SRD attribution

Rules content comes from SRD 5.2.1 under CC-BY-4.0. A deployment must show this exact statement on an About/Legal page linked from every screen's footer (spec section 8):

> This work includes material from the System Reference Document 5.2.1 ("SRD 5.2.1") by Wizards of the Coast LLC, available at https://www.dndbeyond.com/srd. The SRD 5.2.1 is licensed under the Creative Commons Attribution 4.0 International License, available at https://creativecommons.org/licenses/by/4.0/legalcode.

"Compatible with fifth edition" or "5E compatible" is allowed; do not use Wizards marks in the product name. The same statement is in the repository `README.md`. This guide does not claim the web UI page exists; check it before release.

Note (M3-38): local-model entries now need the port. Use `LLM_ALLOW_LOCAL_HOSTS=172.31.25.75:8080` (a bare host allows only ports 80 and 443) and `LLM_ALLOW_LOCAL_HOSTS=localhost:11434` for an Ollama-style endpoint; the examples above that list a bare host are superseded.


Note (M3-38 r2): bare-host `LLM_ALLOW_LOCAL_HOSTS` examples above are superseded. A bare host allows only ports 80 and 443. For a non-default port, list `host:port` exactly (for example `localhost:11434` or `172.31.25.75:8080`). This applies to the server guard, `apps/server/scripts/smoke-production.mjs`, and the live eval path (`packages/evals`).

Note (M3-38 r3): the live eval path now applies the same port rule to `https:` endpoints, so `https://172.31.25.75:9999` is refused when only `172.31.25.75` is listed. It also strips a trailing dot from the URL host (as the guard does), refuses URL credentials, and refuses metadata and link-local IP literals even when listed. It does not follow redirects (a 3xx from the live endpoint is an error). It does not resolve DNS: a hostname that resolves to a private or metadata address is not refused by the live path, so list only hosts you control. Entries are not dot-normalized: `localhost.:11434` in the list matches nothing. The shared verdict corpus is `packages/evals/data/live-url-corpus.json`.

## ADR-039 one-time legacy derived-memory clear (operator gated)

This is a separate build-only operator job, not part of startup, the retention sweeper, migrations, CI, or package lifecycle scripts. It is disabled by default. Live mode requires a recent successful dry run, an explicit owner go-ahead for that execution, and a recent backup attestation.

Worst case: after a fresh dry run with reconciliation complete, every uncovered `scene_summaries` row and every uncovered `registry_entries` row (and their `registry_facts` cascade) in non-held, non-deferred, non-skipped sessions is deleted permanently, including NPC/world entries without character tokens. A session with any supersession link is deferred whole and none of its derived-memory rows are removed by this job. There is no rebuild or rollback.

### Procedure

1. Select the target database explicitly. Confirm ADR-039 steps 1–3 are deployed and migrations 0045–0052 are applied. Global reconciliation must be complete for live mode; only globally incomplete reconciliation refuses live and writes an `aborted` audit row with reason `global_reconciliation_incomplete`. Sessions in `derived_memory_reconcile_skipped` are deferred and untouched; live may complete other eligible sessions. Any unheld session with any `supersedes_id` or `superseded_by` link is deferred whole and counted in `sessionsDeferredChain`; no rows from that session are deleted.
2. Required backup and restore check before live execution: create a custom-format dump, inspect it, and restore it to a separate empty scratch database. Keep the file and database URLs in a protected local environment; never store them in the repository, PR, logs, or audit.

       test -n "$DATABASE_URL" || exit 1
       test -n "$BACKUP_FILE" || exit 1
       test -n "$RESTORE_DATABASE_URL" || exit 1
       pg_dump --format=custom --no-owner --file="$BACKUP_FILE" "$DATABASE_URL"
       pg_restore --list "$BACKUP_FILE" >/dev/null
       pg_restore --exit-on-error --no-owner --dbname="$RESTORE_DATABASE_URL" "$BACKUP_FILE"
       psql "$RESTORE_DATABASE_URL" -v ON_ERROR_STOP=1 -c "SELECT current_database(), (SELECT count(*) FROM scene_summaries), (SELECT count(*) FROM registry_entries), (SELECT count(*) FROM registry_facts)"

   Confirm restore success and that current_database() identifies the separate scratch target. Only then capture the attestation timestamp:

       export DERIVED_MEMORY_LEGACY_CLEAR_BACKUP_CONFIRMED_AT="$(date -u +'%Y-%m-%dT%H:%M:%S.000Z')"

   Live mode rejects a missing, malformed, future, or older-than-24-hour timestamp with an aborted audit row and reason backup_not_confirmed. The timestamp alone is recorded; no path, URL, credential, or dump metadata is stored.
3. Build the exact deployed revision and set DERIVED_MEMORY_LEGACY_CLEAR_CODE_VERSION to that immutable revision. Keep DERIVED_MEMORY_LEGACY_CLEAR_ENABLED unset/false except during invocation.
4. Run a dry-run first:

       export DERIVED_MEMORY_LEGACY_CLEAR_ENABLED=true
       export DERIVED_MEMORY_LEGACY_CLEAR_CODE_VERSION=<immutable-revision>
       pnpm --filter @game/server derived-memory:legacy-clear

   Dry-run deletes nothing. Review the successful audit counts, including held/deferred sessions, `sessionsDeferredChain`, and uncovered summaries/entries/facts. The approval citation contains no email address; audit rows and logs are counts-only and have no row/session ids or row text.
5. Obtain the owner's explicit go-ahead for this live execution. After the backup restore check, use the same database and immutable code version, and set the recent attestation timestamp. Fresh live counts must match the dry-run plan within configured tolerance (default zero). Set both live gates explicitly:

       export DERIVED_MEMORY_LEGACY_CLEAR_ENABLED=true
       export DERIVED_MEMORY_LEGACY_CLEAR_DRY_RUN=false
       export DERIVED_MEMORY_LEGACY_CLEAR_CODE_VERSION=<same-immutable-revision>
       export DERIVED_MEMORY_LEGACY_CLEAR_BACKUP_CONFIRMED_AT=<recent-ISO-timestamp>
       pnpm --filter @game/server derived-memory:legacy-clear
6. Review derived_memory_legacy_clear_audit ordered by started_at, including mode, counts, dry-run link, heartbeat, backup_confirmed_at, outcome, and fixed reason_code. Disable both gates after completion. Never run against real data without the owner's go-ahead.

Each session batch writes cumulative removed counts and refreshes `heartbeat_at` in the same transaction as that session’s deletion, so a crash cannot commit one without the other. A SIGKILL leaves the audit outcome `running` until a later invocation obtains the advisory lock; that invocation marks stale rows (default heartbeat window 15 minutes) `failed` with reason `process_died`, retaining their last persisted counts. A resume must use the same still-recent dry-run id and the exact expected remaining counts: remaining candidates plus the audit’s completed-removal counts must equal the dry-run counts. Any unexplained increase or decrease refuses before deletion; take a fresh dry run before trying again. The per-session lock timeout defaults to 5000 ms. Rollback: none; completed deletion is permanent.
