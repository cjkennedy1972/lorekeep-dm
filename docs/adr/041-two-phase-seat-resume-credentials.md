# ADR-041: Two-phase seat resume credentials

Status: Proposed · Date: 2026-10-31 · Owner: Chris Kennedy · Work item: seat-credential residual

Append-only: this ADR supersedes the process-local unresolved-invalidation fence as the safety mechanism for failed credential delivery. It does not change the seat ownership, host-approval, or solo-owner-recovery policies in ADR-031, ADR-036, and ADR-037.

## Context

A seat resume token is a random 128-bit bearer credential. The server stores its SHA-256 hash in `seat_resume_tokens.token_hash`. The socket lease (`active_socket_id`, `heartbeat_at`) serializes the controlling socket and considers a socket live for 15 seconds, as established by PR #436. The current `ws.ts` path commits a new token hash before sending `SeatAuthenticated`. If send reports failure, it tries rollback and invalidation writes. Consecutive database failures can leave a token hash valid even though the player may never have received that token.

PR #441 improved ordinary rollback and PR #444 added invalidation retries and an in-process fence. The fence protects only its server process and disappears on restart. Another gateway sharing the database can accept the credential after lease expiry. Persisting a separate invalidation marker in the same unavailable database does not solve this ordering defect.

The invariant is: **only a durably activated credential authenticates; a pending candidate never authenticates on any process or after restart.** A send error is ambiguous: it does not prove that zero bytes reached the client.

## Decision

Use a database-backed two-phase rotation. Leave the current active hash unchanged while a candidate is pending. Send the candidate only over a transport verified as TLS, have the client durably store it before sending its receipt ACK, then promote it with one compare-and-swap (CAS). The same activation CAS replaces the active hash and records durable ACK-idempotency data. No rollback or invalidation write is needed to make an undelivered candidate safe: pending candidates categorically do not authenticate.

The client stores both its current token and the candidate before sending `SeatResumeTokenReceived(rotationId)`. It retains both until `SeatResumeTokenActivated(rotationId)` arrives. On reconnect it first presents its old token; only if the server returns the ordinary invalid-token result does it retry once with the persisted candidate. While still pending, the candidate is rejected; after activation, that candidate is the active credential. This two-attempt rule is bounded to one old-token attempt and one candidate attempt per reconnect. If both credentials fail or the client lost the persisted candidate, the existing host-approved recovery path applies. Never discard the candidate before confirmation or log the candidate or its hash; diagnostics and host-visible audit events contain event names and seat ids only.

Rotation ids are server-generated UUIDv4 values from the application CSPRNG (`crypto.randomUUID`, `crypto.randomBytes`, or an equivalent cryptographic generator). Candidate tokens also come from the application CSPRNG. The existing `md5(random()::text ...)` pattern is forbidden for any security-relevant id or credential. The server-side socket id is unique per connection, never reused, and never sent to clients. ACKs are accepted only on the currently open WebSocket that received the candidate; socket identity is derived server-side, not supplied by the client. Unknown-rotation, wrong-socket, expired, and otherwise rejected ACKs have the same externally observable response so they do not form an oracle.

**Clock rule:** all lease, pending-expiry, rate-window, and audit-time comparisons and values use PostgreSQL `clock_timestamp()`, including after advisory-lock waits; transaction-start timestamps are never used.

**Transport rule:** do not emit `SeatAuthenticated` or a candidate unless the server verifies a TLS connection. Direct TLS is accepted. Behind a proxy, accept TLS only when the peer address is in a configured trusted-proxy list and that proxy attests `X-Forwarded-Proto: https`; ignore that header from untrusted peers. A loopback/development exception is available only behind an explicit configuration flag, OFF in production. Serialization/logging middleware must redact candidates and hashes, not merely rely on call sites to omit them.

Rotation is an effective revocation of the old token **at activation**: unlike a design that retains the old hash after activation, the old hash is immediately replaced, and no prior-token slot remains. A stolen old token remains usable during the pending phase, but stops authenticating as soon as activation commits. Rotation does not revoke a stolen token before activation; seat revocation or session deletion remains the emergency revocation mechanism.

### Exact row state machine

One row remains keyed by `(session_id, seat_id)`. `token_hash` is the only authenticating credential hash. Pending values and last-activation metadata never authenticate.

| State | Row predicate | Authentication |
|---|---|---|
| `ACTIVE` | No pending tuple; `token_hash` is current | Active hash only |
| `PENDING` | Pending hash/id/socket/expiry/start-time/rate-window tuple is set and expiry is in the future | Active hash only; pending hash is always rejected. Pending metadata never blocks authentication with a valid active credential. |
| `PENDING_EXPIRED` | Pending tuple exists but `pending_expires_at <= clock_timestamp()` | Active hash only; expiry itself never blocks valid authentication; cleanup is opportunistic. |

Transitions (all stated writes are in the same transaction as their authorization/lease decisions):

1. **Authorize, take over if needed, begin rotation:** `authorizeSeatSocket` takes the existing transaction/advisory lock and applies the live-lease-first policy. The lease is the only cross-socket controller exclusion. Pending metadata is never a reason to refuse a valid active-token reconnect, host-approved claim, or eligible solo-owner recovery. When an authorized new socket obtains the seat after the prior lease is expired or no longer owned, abort any other socket's pending tuple by CAS over the exact `(pending_rotation_id, pending_token_hash, pending_socket_id)` and lease ownership, then reserve the new socket. A valid active token on a live current socket cannot start a concurrent second rotation; its existing socket may retry after its pending tuple expires or is aborted. Host-approved and solo-owner eligibility checks remain unchanged.

   For a permitted start, generate candidate `Tn` and rotation id `Rn`. In the same transaction, CAS-set `pending_token_hash=sha256(Tn)`, `pending_rotation_id=Rn`, `pending_socket_id=serverSocketId`, `pending_expires_at=clock_timestamp()+interval '30 seconds'`, `pending_started_at=clock_timestamp()`, and the current rate-window association, leaving `token_hash` unchanged. The per-seat cap is six starts that fail to activate in each anchored 60-second window. The counter is updated in the SAME CAS/transaction that begins the pending rotation; a failed pending-row write does not count. On successful activation, refund that start in the same activation CAS if its recorded window is still the current window. Aborted, expired, and otherwise non-activated starts remain counted. At a new window, reset the counter before admitting a start. Successful rotations therefore do not consume the failure budget.

   At the cap, valid-token authentication is still admitted with the existing token and receives a rotation-deferred indication. A host-approved claim is likewise admitted under existing policy, even at the cap, but receives no new token; if it later reconnects without a token it must use host-approved recovery again. At most one pending tuple may exist per seat. Host-approved claims can therefore cause bounded pending churn, never authentication or claim refusal. Emit host-visible `SeatRotationDeferred` and `SeatRotationAborted` audit events (and the existing `SeatTakenOver` event where applicable); include seat id and event metadata only, never token, hash, or socket id.

2. **Send candidate:** after pending CAS commits, send `SeatAuthenticated(Tn,Rn)` over a verified TLS transport. On send failure or connection close, best-effort clear pending fields by CAS matching the exact pending tuple and socket. If that write fails, candidate expiry and valid-token takeover are authoritative cleanup. The candidate remains non-authenticating regardless of cleanup outcome. A live socket with no ACK cannot start a second pending rotation; it may retry after abort/expiry, and that non-activated start counts toward the cap.

3. **Client receipt ACK:** the client must first durably persist `Tn` associated with `Rn`, then send `SeatResumeTokenReceived(Rn)`. First check the durable duplicate-ACK case in step 5. Otherwise accept only if the pending tuple, deadline, current open server-side socket identity, and live lease all match. ACK is not an authentication credential. If the pending tuple expired or was aborted/replaced after a lease-expired takeover, reject with the uniform ACK-rejection response. The client keeps both credentials until activation confirmation.

4. **Activate:** in one transaction/CAS, verify the exact pending tuple, unexpired deadline, and lease ownership; replace `token_hash` with `pending_token_hash`; set `rotated_at`; set `last_activated_rotation_id=Rn`, `last_activated_socket_id=serverSocketId`, and `last_activated_at=clock_timestamp()` in this SAME CAS; update/refund the rate counter as described in step 1; then clear all pending fields. The old token becomes invalid at this commit. If the database reports an error with an unknown commit outcome, do not roll back or start another rotation: treat activation as unknown and let the client retry its ACK on the same still-open socket. If the CAS committed, durable idempotency data allows confirmation to be re-sent; if it did not, the still-pending tuple can be retried while valid. Send `SeatResumeTokenActivated(Rn)` only after a confirmed commit or a successful duplicate-ACK lookup.

5. **Duplicate ACK:** on the currently open connection, a duplicate ACK matching the last activated rotation id and recorded server-side socket id, on the same seat and only while `last_activated_at` is within the bounded 30-second ACK-idempotency window, re-sends `SeatResumeTokenActivated(Rn)` without changing row state. The server socket id is never sent to the client and is unique and never reused. This bounded confirmation window is not a token-authentication window: the old token stopped authenticating at activation. An ACK after the idempotency deadline, for another rotation, or from another socket receives the same response as any other rejected ACK. The client can still reconnect with its durably stored candidate, now the active token.

6. **Expiry, abort, and recovery:** pending expires after 30 seconds. A periodic bounded sweeper clears expired pending tuples; correctness does not depend on prompt sweeping because auth rejects pending hashes and checks expiry synchronously. A takeover after lease expiry clears the old pending tuple in its authorization transaction. Emit `SeatRotationAborted` for an abort/expiry when observable, with seat id only. An expired candidate cannot be activated. The client discards it only after a definitive rejection/expiry response; if uncertain, its two-attempt reconnect rule is safe because only the active hash authenticates.

7. **Revocation/session deletion:** existing row deletion cascades remain authoritative and remove active, pending, rate, and last-activation metadata together.

All credential transitions use CAS predicates over expected rotation id/hash, server-side socket owner, and lease state; activation and ACK require an unexpired pending deadline. The authorization lock remains keyed by `(session_id, seat_id)` and is taken before row decisions. Expiry sweeps use bounded batches with `FOR UPDATE SKIP LOCKED`; they clear pending metadata only and never promote a credential.

### Schema and mixed-fleet guard migrations

Use two ordered migrations. Assign each its actual next-free number at implementation time (currently `0050`; do not hard-code this number in design artifacts).

1. **Additive schema migration:** add nullable `pending_token_hash text`, `pending_rotation_id uuid`, `pending_socket_id uuid`, `pending_expires_at timestamptz`, `pending_started_at timestamptz`, `pending_rate_window_started_at timestamptz`, `last_activated_rotation_id uuid`, `last_activated_socket_id uuid`, `last_activated_at timestamptz`, `rotation_window_started_at timestamptz`, and `rotation_starts_in_window smallint NOT NULL DEFAULT 0`. Add checks requiring pending hash/id/socket/expiry/start/window tuple to be all NULL or all set; last-activated id/socket/time to be all NULL or all set; rate-window start to be NULL exactly when its count is zero; and count between 0 and 6. Add a partial index on `pending_expires_at` where pending hash is non-NULL. No credential backfill is needed: existing `token_hash` rows remain active and new fields start NULL/defaulted. Keep existing PK, revocation trigger, heartbeat-pair check, and 15-second lease semantics.

2. **Protocol-guard migration (separate, after fleet convergence):** add a `BEFORE INSERT OR UPDATE` trigger on `seat_resume_tokens`. For UPDATE, if any protected credential column changes—`token_hash`, any pending column, or any last-activated column—the trigger raises unless `current_setting('app.seat_token_protocol', true) = '2'`. Apply the same protocol-marker requirement to inserts that create/replace credential state. New binaries set `SET LOCAL app.seat_token_protocol = '2'` inside every transaction that writes credential state, including flag-OFF/legacy behavior paths; the marker is transaction-local and cannot leak across pooled connections. Unprotected lease/heartbeat updates continue to work without it. Old binaries do not set the marker, so the database rejects their credential writes fail-closed, including `ON CONFLICT DO UPDATE` writes. The trigger, not an operator checklist or startup-version convention, enforces the boundary. Dropping this trigger is required before any old binary may run during rollback.

A new-binary startup check may additionally refuse to serve seats unless the guard schema is present, but it is defense in depth; it does not replace the trigger. The deployment flag is per-deployment and must remain OFF until the trigger is installed.

### Alternatives considered

| Option | Assessment |
|---|---|
| **A. Pending hash, send, ACK, CAS activate (chosen)** | Pending is categorically excluded from authentication. Keeps the old hash active only until activation, then replaces it immediately. Client write-ahead persistence plus two-attempt reconnect handles lost confirmation without leaving a stolen old token valid after activation. Shared DB state handles processes and restarts. |
| **B. Persisted invalidation marker** | Rejected as primary fix: marker write uses the same database that failed for rollback/invalidation. An outage can leave the marker absent. |
| **C. Deliver then commit** | A delivered-but-uncommitted credential cannot authenticate, and the old token remains active, but this alone lacks durable in-flight identity, socket ownership, idempotent ACK, and safe reconnect semantics. Pending state plus CAS provides those boundaries. |
| **D. Keep both hashes valid until client ACK** | Rejected: accepting the candidate before durable activation reintroduces early validity, while retaining the previous token after activation lets a thief using that token retake the seat. ACK triggers the activation CAS; only the candidate remains valid after it. |
| **E. Process-local fence or durable fence-only** | Rejected: process-local state is not shared; durable fence-only depends on the same database and cannot establish safety when its write fails. Safety follows from the pending-vs-active credential state. |

## Consequences and code sites

- `apps/server/src/gateway/resumeTokens.ts`: change `authorizeSeatSocket` to reserve a pending candidate without overwriting the active hash; authenticate only against `token_hash`; add begin/activate/abort/sweep and duplicate-ACK operations; update the cap in the same row CAS; use `clock_timestamp()` in every expiry/window/lease operation and set the protocol marker in every credential-write transaction. Keep these rules behind a cohesive rotation interface.
- `apps/server/src/gateway/ws.ts`: replace commit-before-send plus rollback/invalidation retries with pending reservation → verified-TLS `SeatAuthenticated` → client receipt ACK → activation CAS → activation confirmation. Add exact two-attempt reconnect behavior and uniform ACK rejection; validate socket identity from the server-side WebSocket. Publish the host-visible audit events with seat id only. Enforce direct/proxy-attested TLS before emitting authentication/candidate messages; redact secrets at serialization/logging middleware.
- Client wire schema and token persistence: stage candidate durably before ACK; retain active and candidate until activation confirmation; retry ACK on the same live socket if activation outcome/confirmation is unknown; after reconnect try old token first, then candidate only after invalid-token; discard only a definitively rejected/expired candidate. The server socket id is never on the wire.
- Add migration tests and gateway tests in `apps/server/test/db/gateway.test.ts`, plus client protocol tests. Both gateway instances in the shared-DB test must run production authorization/activation code.
- Remove `unresolvedInvalidations`, invalidation retries, and lease-retention special cases once cutover is complete. The #436 lease remains for controller serialization, not credential revocation. Host approval and solo-owner recovery policies remain unchanged. A stolen token that repeatedly wins the expired-seat lease can degrade legitimate-device rotations; host-visible `SeatTakenOver`, `SeatRotationDeferred`, and `SeatRotationAborted` events make this detectable, and seat revocation is the mitigation.

## Failure modes

“Attacker” means someone presenting a credential without the legitimate device; the table assumes no database compromise, XSS, or stolen account cookie. A send error is ambiguous about whether bytes arrived. Rotation does not revoke the old token while a candidate is pending, but activation replaces the old hash immediately. A stolen old token can win a seat while it remains active and can repeatedly degrade the legitimate device's rotations by winning after lease expiry. This is surfaced to the host by takeover/deferred/aborted audit events; revoke the seat or delete the session to stop the stolen token. Host-approved recovery remains available.

| Failure/crash point | Player sees / recovery | What an attacker can do |
|---|---|---|
| Pending-row CAS fails before send | No candidate; existing active token still works; host-approved recovery remains available | Cannot use candidate; active hash remains unchanged |
| Send fails and pending clear succeeds | No confirmed candidate; reconnect with old token | Candidate never authenticates |
| Send fails and pending clear also fails | Client may or may not have received candidate; reconnect old-first, candidate-second only if old is invalid | Pending candidate is rejected on every process/restart; old token remains active until activation |
| Server crashes after pending write, before send | Client has no candidate; old token works after lease expiry; pending expires/sweeps | Candidate cannot authenticate |
| Server crashes during/after send, before ACK | Client may have staged candidate; old token still authenticates; client reconnect tries old then candidate if old is invalid | Candidate cannot authenticate while pending; old token remains usable until activation |
| Send succeeds, socket remains live, no ACK | Client retains old and durably staged candidate; this socket cannot start another rotation until pending abort/expiry; after expiry it retries. This non-activated start counts toward the cap. | Candidate cannot authenticate; only active old token works |
| ACK arrives after pending expiry, before sweeper | Uniform ACK rejection; client discards candidate after definitive expiry; old token still works; this non-activated start counts toward cap | Cannot activate expired candidate |
| ACK from wrong socket or unknown/old rotation id | Same uniform rejection as expired/invalid ACK; no state change | Cannot probe whether a rotation id exists or activate another socket's candidate |
| Activation CAS fails before commit | Client already durably staged candidate and retains old; retry ACK while pending/live, or reconnect using old-first then candidate | Candidate cannot authenticate unless activation commits; old remains active |
| Activation DB error with unknown commit outcome | Server does not roll back. Client retries ACK on the same open socket: if committed, last-activation record re-sends confirmation; if not committed and pending still valid, retry attempts activation. If disconnected, client reconnects old-first then candidate on invalid-token. | If commit happened, candidate is active and old token is invalid; if not, only old token is active. No ambiguous credential is accepted. |
| Activation commits, process crashes before confirmation | Client retained candidate before ACK. Retry on same socket if still open, otherwise reconnect old-first (invalid) then candidate succeeds. If candidate was lost too, host-approved recovery applies. | Candidate is the sole active token; old token stopped authenticating at the commit. |
| Confirmation send fails after activation | Client keeps both; retries ACK on current socket or reconnects old-first then candidate. If it lost candidate, host-approved recovery applies. | Old token is immediately invalid; only the activated candidate works |
| Client ACKs, then crashes before persisting candidate | This ordering violates the client protocol. The server's ACK proves only receipt, not durable persistence; on reconnect old token is invalid, so recover through host approval. Client must persist-before-ACK. | Only the newly activated token works; old token is invalid |
| Pending sweeper fails | Pending row remains until later sweep/takeover; synchronous expiry checks still reject candidate and allow active token | No additional credential is accepted |
| Two gateway instances share DB; one crashes/restarts | Both see the same active/pending state and lease; reconnect candidate works only if activation committed | Neither instance authenticates a pending hash; no process-local fence is required |
| Old socket stalls beyond 15s with pending rotation; valid old-token socket reconnects | After lease expiry, valid active token is admitted; transaction aborts stale pending tuple and may begin a new rotation | Aborted candidate stays non-authenticating; stale ACK fails CAS |
| Rotation cap reached | Valid-token socket remains authorized without rotation. Host-approved claimant is admitted without a candidate; on later tokenless reconnect it uses host approval again. Retry after the anchored window | Repeated stolen-token takeovers can defer legitimate rotations; host sees audit events and can revoke the seat |
| Database protocol trigger rejects legacy write | New version continues only if it supplies the marker; old binary write fails closed and cannot overwrite protected credential state | Legacy path cannot change active/pending/activation credentials after guard installation |
| Host-approved claim or solo-owner recovery | Existing authorization policy admits claim; candidate is pending until ACK and activation; if at cap, claim remains admitted without a candidate | Claim policy is unchanged; pending candidate itself cannot bypass authorization |

## Test plan (failing-first)

1. Prove pending hashes are rejected for presented-token, tokenless, host-approved, and solo-owner paths; active hash authenticates; expired pending never blocks a valid-token reconnect.
2. Inject pending-CAS failure, send callback error/throw, pending cleanup failure, activation failure before commit, and confirmation-send failure. Assert old-token continuity before activation, immediate old-token rejection after activation, pending candidate rejection, and no credential/hash in logs.
3. Restart test: persist pending row, destroy gateway, create a fresh gateway against same DB after lease expiry, prove pending token rejected; cover crash after send/before ACK and activation commit/before confirmation.
4. Two-process test: two independent gateway instances with separate in-memory state race production authorization/activation against one Postgres DB. Exactly one activation wins; stale rotation/socket IDs cannot activate; pending hash never authenticates. Recreate the first instance and repeat.
5. Race sweeper vs ACK, pending replacement, heartbeat expiry, revocation, host approval, and solo-owner recovery. Prove valid old-token reconnect aborts other socket's pending tuple after lease expiry.
6. ACK tests: duplicate ACK after activation re-confirms without a state change on the same open socket; expiry, wrong socket, unknown/old id, and expired duplicate ACK all have indistinguishable rejection; activation commit-outcome-unknown retries idempotently.
7. Client tests prove candidate durable write precedes ACK; old-then-candidate two-attempt reconnect; pending candidate rejected then activated candidate accepted; old token rejected immediately at activation; if candidate is lost, host-approved recovery works.
8. Rate tests: only unactivated starts consume the six-per-anchored-60-second budget; activation refunds the start; abort/expiry consumes it; counter update is atomic with pending-start CAS; boundary reset uses `clock_timestamp()`; host-approved claim at cap is still admitted without a token; a valid-token reconnect at cap is not refused.
9. Clock tests assert `clock_timestamp()` is used for every lease, pending expiry, rate-window, and idempotency deadline comparison/value, including after lock waits; no transaction-start clock is used.
10. Protocol guard tests: legacy-style credential writes without `SET LOCAL app.seat_token_protocol = '2'` are rejected; marked writes succeed; unprotected lease/heartbeat updates continue; `ON CONFLICT DO UPDATE` is guarded; trigger rollback permits legacy writes only after explicit guard removal.
11. TLS/proxy tests: candidate and `SeatAuthenticated` are refused on plaintext except the explicit loopback/dev flag; trusted proxy TLS attestation works only for configured proxy addresses; untrusted forwarded headers fail; serialization/logging redacts tokens and hashes.
12. Migration tests verify existing rows remain active, columns/checks/indexes exist, additive migration precedes trigger migration, and session deletion/revocation removes all row state.

Do not call a helper spy a multi-process test: both gateways must execute production logic against the same database. Run migration/DB suites, typecheck, formatting, and required CI on the implementation PR.

## Rollout and estimate

Docs-only decision; implementation estimate **L** because it spans server persistence/gateway, client token persistence and reconnect logic, two migrations, transport/proxy configuration, mixed-fleet enforcement, and race/failure tests.

1. Apply the additive schema migration only. Its number is the next free migration at implementation time (currently 0050).
2. Deploy the new server binaries to every gateway instance with the deployment-wide feature flag OFF. Every credential-writing path in these binaries must set the transaction-local protocol marker, even with the flag OFF. Drain old binaries and old connections; do not proceed until the fleet is converged.
3. Apply the separate protocol-guard trigger migration only after all gateways run the new binaries. The trigger now makes any old binary's protected credential write fail closed.
4. Enable the deployment-wide `SEAT_RESUME_TWO_PHASE_ENABLED` flag only after the trigger is installed. There is no supported mixed-fleet phase.
5. Enable in staging, then production; monitor pending expiry, activation CAS misses/unknown outcomes, takeover/deferred/aborted events, cap use, and host-approval recovery without logging credential material.
6. Rollback: turn the flag off; converge the fleet to the intended rollback binary; drop the protocol trigger before any old binary runs; safely handle pending state. Never run old and new gateway binaries concurrently against the same seats. Migration down is unsupported after two-phase rows are used.

## Plain-language explanation for the owner (10 lines)

1. Today the server saves a new password before it knows whether the player received it.
2. If sending fails, the server tries to undo that save.
3. If undo also fails, the database can keep a password the player may never have seen.
4. A temporary safety list in one server process does not protect another process or a restart.
5. The fix is to save the new password as “waiting,” not as usable.
6. The player saves that waiting password before confirming receipt.
7. One database update then activates it and immediately retires the old password.
8. If confirmation is lost, the player tries the old password and then the saved new one.
9. If anything fails before activation, only the old password works; the waiting one never does.
10. The shared database and its protocol guard make every server follow the same rule.

## Verification

This is a proposed design, not implemented behavior. Source reviewed: PRs #436, #441, and #444, including owner/security review comments; `apps/server/src/gateway/ws.ts`; `apps/server/src/gateway/resumeTokens.ts`; migrations 0038–0040 and 0039 socket-lease changes; and relevant tests in `apps/server/test/db/gateway.test.ts`. Implementation acceptance requires the failing-first plan above and green CI; this ADR does not claim those checks ran.
