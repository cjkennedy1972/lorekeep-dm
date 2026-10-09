# M2-40 fix review (PR #93, PR #94)

Independent static review of squash commits `f62069e` (#93) and `37c0335` (#94) against findings F1–F4 in
`m2-review.md`. Reviewed at `origin/main` = `b18b45b`. Method: diff + source reading, plus reasoning about
bypasses. **No tests were run and no code was executed**; verdicts below are from code reading only. No secret
values were read or printed.

## Verdicts

| ID | Verdict | Summary |
| --- | --- | --- |
| F1 | **Closed** (one usability bug) | Host/style change without a new key is refused; route returns 500 instead of 4xx. |
| F2 | **Partially closed** | Prompt hiding and orchestrator enforcement use different tool lists. |
| F3 | **Partially closed** | Per-socket bucket and Room caps work; no per-account/IP bound across sockets or reconnects; misleading double error. |
| F4 | **Closed** | Dev fallback is reachable only with `NODE_ENV` exactly `development`/`test` and no configured key. |

## F1 — saved key redirect/readback: Closed

- `apps/server/src/llm/config.ts:228-246`: the row is locked (`FOR UPDATE`), `base_url`/`api_style` are
  compared with the request, and `KEY_REQUIRED` is thrown when either changed, a saved key exists and
  `apiKey === undefined`. Transaction rolls back (`config.ts:~280`), so nothing is written.
- Redirect path closed: the stored key can no longer be re-pointed at a new host by a save without a key.
  `testEndpoint` (`config.ts:~330`) only uses stored URL + stored key. Any string difference in `baseUrl`
  (trailing slash, path, case) also demands a key, which is stricter than needed but safe.
- Readback: saves return only `keySet` and a 12-hex fingerprint (`config.ts:~275`); no response path returns
  plaintext. `apiKey: ""` passes the schema (`z.string().max(4096)`, `config.ts:23`) and clears the key, which is
  fine.
- Test: `test/db/operatorEndpoints.test.ts` covers host change. Not covered: `apiStyle`-only change, path-only
  change, same-URL model change still reusing the key.
- **Bug (Low/Med, usability):** `routes/operator.ts:55-76` does not map `KEY_REQUIRED`; the error falls through
  to `throw error` → HTTP 500. Operators see an opaque failure instead of a 4xx prompt for a key.
  - Failing-first test: PUT `/api/operator/endpoints/fast` with a changed `baseUrl` and no `apiKey` after a key
    was saved; expect 400 `{code:'KEY_REQUIRED'}`, currently 500.

## F2 — tool mode gating: Partially closed

- `dm/orchestrator.ts:469-488` rejects `attack`, `cast_spell`, `apply_condition`, `remove_condition`,
  `end_combat` when `prompt.activeMode !== 'combat'`, before executor invocation. `productionTurnRunner.ts:360-366`
  now derives `activeMode` from `state.combatRoom`.
- **Mismatch (confirmed by reading):** the prompt hides `attack, cast_spell, move_to, suggest_area_target,
  start_combat, end_combat` outside combat (`dm/prompt.ts:~86-95`) but the orchestrator enforces a different
  set. Consequences:
  1. `move_to` and `suggest_area_target` are hidden from the model but **not blocked** in exploration, so a
     prompt-injected/forged call still reaches the executor (`orchestrator.ts:198-215` whitelist accepts them).
  2. `apply_condition`/`remove_condition` are **advertised** in exploration but now always rejected, so
     legitimate non-combat condition use burns retry budget (`MAX_RETRIES_PER_TURN`) and can end in a
     `budget-exhausted` fallback.
  3. `start_combat` is hidden but allowed, which is probably intended (it is the entry to combat); this should
     be stated explicitly.
- Same-turn transition is safe: mode is fixed per turn, so an `attack` after `start_combat` in one turn is
  rejected (fail-closed).
- The test only covers `attack`.
- Repair: derive both the prompt filter and the orchestrator check from one exported constant.
  - Failing-first test: parameterize over every tool the prompt hides in exploration; assert executor
    invocations are 0 for all except `start_combat`. Currently `move_to` and `suggest_area_target` execute.

## F3 — queue and message-rate caps: Partially closed

What holds:
- `gateway/ws.ts:194-217`: the token bucket (cap 20, 10/s) is consumed **before** `chain` grows (#94), so a flood
  no longer builds an unbounded promise chain; rejected frames cost one JSON-free `send`. Messages buffered before
  join (`ws.ts:~150-160`, max 32) also pass through `dispatch`, so they are not a bypass.
- `room/Room.ts:34-35,494-513`: seat cap 3 (in-flight counts as 1) and room cap 12. Payload text is capped at
  4000 chars (`packages/schema/src/ws.ts:16`) and frames at 64 KB (`ws.ts:21`, `maxPayload`), so a payload just under
  64 KB is rejected at the socket or at schema validation, never queued. Rejected actions do not add to
  `pendingActions`/`actionIds`, so there is no leak from rejection.
- Queued LLM work is bounded at 12 per room regardless of socket count.

Residual weaknesses:
1. **Bucket is per socket, not per account/IP.** `ws.ts:195-199` creates the bucket inside the connection
   handler. N sockets for one account (or reconnecting) get N × (20 burst + 10/s). Reconnect resets the bucket to
   full. Tickets are single-use but issuing them (`ws.ts:45-67`) has no visible rate limit in the code I read
   (`rateLimit` appears only in `routes/auth.ts`). Impact: bounded CPU/DB work (each `PlayerAction` does a
   `SELECT display_name`, `ws.ts:~308`), not LLM cost, because the Room caps hold. Repair: key the bucket by
   `accountId` in a shared map (or rate-limit `/api/ws-ticket`), and cap sockets per account.
2. **Resync amplification.** `Resync` (`ws.ts:~262`) costs one token but forces a full `StateSync` plus combat
   snapshot (`Room.ts:132-146`) through `Room.enqueue`, shared by all seats. Multiple sockets multiply it.
   The 4× `MAX_BYTES` slow-consumer close (`ws.ts:~108`) limits memory, not Room serialization time.
3. **Misleading error.** When `submitAction` rejects at the cap it broadcasts `ACTION_REJECTED` to the **whole
   room** (`Room.ts:503-512`, `this.broadcast`) and returns `false`; `ws.ts:~318` then also sends
   `DUPLICATE_ACTION` to the sender. One member can make every client see error toasts, and the sender gets a
   wrong second error. Repair: `sendError(accountId, ...)` and return `true`/distinct result.
   - Failing-first test: fill the seat cap, then assert the 4th submit yields exactly one `ACTION_REJECTED` to
     the submitter only and no `DUPLICATE_ACTION`; another seated connection receives nothing.
4. **Engine-generated narration bypasses the caps** (`Room.ts:866-877` pushes to `queuedActions` directly). It
   is bounded by combat events and takes an owner seat, but it does consume the 12-slot room budget and can
   starve a player's action with `ACTION_REJECTED`.
5. Combat commands are checked against `turnInFlight` only (`Room.ts:742`), not rate-capped beyond the socket
   bucket; acceptable.
- Test gaps: `dmTurn.test.ts` covers only the per-seat cap; the room cap (12), multi-socket and reconnect cases
  have no tests. The #94 flood test (200 frames, ≥150 `RATE_LIMITED`) is a good regression for ordering.

## F4 — dev key fallback in production: Closed

- `config.ts:48-62` (`masterKey`): with no key, only `NODE_ENV` ∈ {`development`,`test`} may use the fallback;
  unset/empty/other values throw (verified: `?? ''` is not in the list → throw).
- `config.ts:149-155` (`decryptEndpointKey`): a `dev` envelope is refused if any key is configured or the env is
  not dev/test. `main.ts:16-19`: boot now requires operator emails and a master key for anything but
  dev/test.
- Env combinations considered: unset `NODE_ENV` with no key → encrypt/decrypt throw (fail-closed);
  `staging`/typos → throw; `production` + key → dev envelopes refused; dev/test + key set → dev envelopes
  refused. A configured key id literally named `dev` would be refused on decrypt (self-lockout, operational
  only, not a weakness).
- Note (informational): `main.ts` uses the zod-defaulted `config.NODE_ENV` (default `development`) while
  `llm/config.ts` reads raw `process.env.NODE_ENV`. With `NODE_ENV` unset, boot passes the `main.ts` gate
  without a key, but any key operation then throws; this fails closed at first use, not at boot. Repair
  (optional): have `masterKey` receive the validated config value or make `main.ts` use the raw env.
- Test: `test/llm/config.test.ts` covers production refusal and configured-key refusal; unset `NODE_ENV` is not
  tested.

## Other regressions / notes

- `combat.test.ts` now paces commands at 100 ms to stay under the bucket; any future client (the live Room
  screen, M2-36) that sends bursts >20 will see `RATE_LIMITED` with no client handling guaranteed. Confirm the
  web client treats `RATE_LIMITED` as non-fatal.
- Low findings F5–F9 remain open and deferred per `m2-review.md` Disposition; not re-reviewed here.

## Limits

Static review only; I did not run the suite, a live server, or CI locally. Claims about the route 500 and
broadcast scope come from reading `operator.ts`, `Room.ts` and `ws.ts` at `b18b45b`.
