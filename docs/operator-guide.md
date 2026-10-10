# Operator guide: LLM endpoints, recorded-LLM replay, tests, SRD attribution

For the person running a Lorekeep-DM server. Background: [ADR-013](adr/013-llm-provider-adapter-tool-fallback.md), [ADR-012](adr/012-eval-strategy.md), [endpoint egress runbook](security/m2-endpoint-egress.md). Placeholders such as `<your-key>` are never real values; do not paste real keys into docs, tickets, or shell history you share.

## 1. Server environment

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres connection string (required). |
| `OPERATOR_EMAILS` | Comma-separated emails of accounts allowed to use `/api/operator/*`. Empty means nobody. Everyone else gets `404 NOT_FOUND`. |
| `OPERATOR_ENDPOINT_MASTER_KEY` | AES-256-GCM key for stored endpoint API keys: 32 bytes as 64 hex chars or base64, or a keyring `id:key,id:key`. Required when `NODE_ENV=production`; outside production a fixed development key is used, so never reuse a development database in production. |
| `OPERATOR_ENDPOINT_ACTIVE_KEY_ID` | Keyring entry used for new writes (default: last entry). |
| `LLM_ALLOW_LOCAL_HOSTS` | Comma-separated exact hosts allowed to be loopback/private and to use plain `http` (section 2). Default empty. |
| `SOLO_TURN_ENDPOINT_SLOT` | Slot used for solo turns: `fast`, `frontier`, or `moderate` (default `moderate`). |
| `AGE_RETRY_SECRET` | Required unless `NODE_ENV` is exactly `development` or `test` (the server refuses to start without it), together with `OPERATOR_EMAILS` and `OPERATOR_ENDPOINT_MASTER_KEY`. |
| `LLM_FIXTURE_MODE`, `LLM_FIXTURE_PATH` | Recorded-LLM mode and file (section 4). |

Generate a master key locally (output is a secret; put it in your secret manager, not in the repo):

```sh
openssl rand -hex 32
```

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
