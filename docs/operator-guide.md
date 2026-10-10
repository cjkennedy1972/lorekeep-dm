# Operator guide: LLM endpoints, recorded-LLM replay, tests, SRD attribution

For the person running a Lorekeep-DM server. Background: [ADR-013](adr/013-llm-provider-adapter-tool-fallback.md), [ADR-012](adr/012-eval-strategy.md), [endpoint egress runbook](security/m2-endpoint-egress.md). Placeholders such as `<your-key>` are never real values; do not paste real keys into docs, tickets, or shell history you share.

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
| `SOLO_TURN_ENDPOINT_SLOT` | No | `moderate` | Must be `fast`, `frontier`, or `moderate`. | Endpoint slot used for solo turns. |
| `LLM_FIXTURE_MODE` | Must be unset | unset (live endpoint) | `strict` is the only allowed value in production; `lenient`/`record` fail boot, and unknown values fail. | Recorded-LLM replay, section 4. |
| `LLM_FIXTURE_PATH` | No | `fixtures/solo-turn.ndjson` | Read only when fixture mode is set. | Section 4. |
| `SWEEP_INTERVAL_MS` | No | `3600000` | Non-integer or negative fails config load. | `0` disables the retention sweeper. |
| `ROOM_DRAIN_DEADLINE_MS` | No | `30000` | Non-integer or negative fails config load. | Shutdown stops waiting for in-flight turns after this many milliseconds and releases the room lease; `0` gives up immediately. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | No | unset (no exporter) | Invalid URL fails config load. | OTLP trace export. |
| `EXPORT_ARCHIVE_DIR` | Yes, set explicitly | `/tmp/lorekeep-exports` | Not in the config schema. Nothing refuses the `/tmp` default. | Export archives are written here (0700 directory, 0600 files). `/tmp` is not acceptable for production data. Card 1ada4844 tracks a production refusal. |
| `WS_ALLOWED_ORIGINS` | Only for cross-origin web clients | unset (same-host origins only) | Not in the config schema; read raw. | Comma-separated full origins (e.g. `https://app.example`). A trailing slash or path never matches. |
| `LLM_API_KEY` | Do not set | none | Parsed and redacted, but no server code path reads it. | Endpoint keys are stored per slot (encrypted), not from this variable. |

Generate a master key locally (output is a secret; put it in your secret manager, not in the repo):

```sh
openssl rand -hex 32
```

### Production behind a reverse proxy

Use nginx: its `proxy_set_header` gives explicit control over `X-Forwarded-For` (overwritten with `$remote_addr`, never appended), the `/ws` upgrade, and per-location timeouts. The sample is [`infra/proxy/lorekeep.nginx.conf`](../infra/proxy/lorekeep.nginx.conf). It is not deployed anywhere; adapt the host name and certificate paths.

- Run the app with `HOST=127.0.0.1`, `PORT=3000`, `TRUST_PROXY=1`, and firewall the app port so only the proxy can reach it. A client that can reach the app port directly can send its own `X-Forwarded-For` and bypass per-IP rate limits whenever the app trusts forwarded headers, so the firewall is required even with a hop count.
- Long LLM turns: HTTP has a 300 s timeout; `/ws` has 3600 s because the connection stays open across turns, and the server pings every 10 s.
- Rate-limit buckets live in process memory, so each instance has its own. Running several replicas multiplies the effective limits.
- Session cookies are `__Host-sid` with `Secure` in every non-development run, regardless of `X-Forwarded-Proto`, so a plain-HTTP request to the app still gets a `Secure` cookie.

Smoke test: `DATABASE_URL=postgres://… pnpm --filter @game/server smoke:prod` after `pnpm -r build`. It migrates the database at `DATABASE_URL` (use a scratch database), boots `dist` in production mode with dummy values and a local stub LLM endpoint, and checks `/healthz`, the login cookie with `X-Forwarded-Proto: https`, separate rate-limit buckets for two forwarded addresses, and one solo turn reaching the stub. It exits non-zero on failure and needs no real credentials.

## 2. Configure an endpoint

Endpoints live in three slots: `fast`, `frontier`, `moderate`. All calls need a session cookie for an operator account (log in through the app or save one with `curl -c cookies.txt -X POST http://localhost:3000/api/login -H 'content-type: application/json' -d '{"email":"<operator-email>","password":"<password>"}'`). On a fresh local database, `POST /api/signup` creates a `pending_email` account and the development mail sender never prints the verification token, so activate it directly: `docker exec infra-postgres-1 psql -U lorekeep -c "update accounts set status='active' where email='<operator-email>'"`. Routes:

| Method and path | Effect |
| --- | --- |
| `GET /api/operator/endpoints` | List slots. Never returns the key: only `keySet` and a 12-hex `keyFingerprint`. |
| `PUT /api/operator/endpoints/:slot` | Save the config; returns it with `"probe": null`. Saving does not call the endpoint: run the test route next. |
| `POST /api/operator/endpoints/:slot/test` | Run the probe on the saved config and store the result (shown as `probe` by `GET`). |
| `DELETE /api/operator/endpoints/:slot` | Remove the slot: `200 {"deleted":true}`, or `404 NOT_FOUND` if the slot is empty. A slot other than `fast`, `frontier`, `moderate` returns `400 INVALID_SLOT`. |

Body for `PUT` (unknown fields are rejected): `baseUrl`, `model`, `apiStyle` (`openai` or `anthropic`), optional `apiKey` (write-only), `contextWindow`, `unsupportedToolSchemaKeywords` (default `[]`; metadata only today, see the egress runbook).

Config changes apply from the next DM turn; a turn already running finishes on the old config.

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
| `validCallRate`, `schemaViolations` | Share of synthetic tool calls that were valid, and count that were not. |
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
