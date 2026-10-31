# ADR-041: Two-phase seat resume credentials

Status: Proposed · Date: 2026-10-31 · Owner: Chris Kennedy · Work item: seat-credential residual

Append-only: this ADR supersedes the process-local unresolved-invalidation fence as the safety mechanism for failed credential delivery. It does not change the seat ownership, host-approval, or solo-owner-recovery policies in ADR-031, ADR-036, and ADR-037.

## Context

A seat resume token is a random 128-bit bearer credential. The server stores its SHA-256 hash in `seat_resume_tokens.token_hash`. The socket lease (`active_socket_id`, `heartbeat_at`) serializes the controlling socket and considers a socket live for 15 seconds, as established by PR #436. The latest path in `ws.ts` reserves/authorizes a socket, commits the new token hash, and then sends `SeatAuthenticated`. If send reports failure, it tries rollback twice, then hash invalidation twice. If those database writes also fail, the database can retain the hash of a token that was not known to have reached the player.

PR #441 improved ordinary rollback and PR #444 added invalidation retries and an in-process fence. The fence prevents this process from accepting the credential, but cannot protect another gateway process sharing the database and disappears on restart. A later rotation can also interact with the fence/rollback state. Persisting a separate invalidation marker in the same database does not solve a database-write outage. This is a durability and ordering defect, not a need for more retries.

The security invariant is: **only a credential whose activation is durably committed may authenticate; a credential awaiting delivery/activation never authenticates, regardless of process, restart, lease expiry, or failed cleanup writes.** A send error is ambiguous: it does not prove that zero bytes reached the client.

## Decision

Use a database-backed two-phase rotation. Keep the currently active hash usable while a new credential is pending. Persist the new hash only in a non-authenticating pending slot, send the credential over TLS (`wss`), and promote it with a single compare-and-swap (CAS) after a client receipt acknowledgement. Failed send, process crash, and all cleanup-write failures leave the pending credential non-authenticating. Do not roll back or invalidate the active hash to make the new one safe. Never log the plaintext candidate or its hash; diagnostics may include event names and opaque identifiers only.

Use a client acknowledgement plus server activation confirmation so the client retains its previous token until the new token is durably active. A successful server send callback is only local transport acceptance, not proof of client receipt. `SeatAuthenticated` carries a server-generated UUIDv4 rotation id (CSPRNG) and candidate token; the client stages the candidate and sends `SeatResumeTokenReceived(rotationId)`. The server validates the ACK against the server-side WebSocket identity, never a client-supplied socket id, CAS-activates that pending hash, and replies `SeatResumeTokenActivated(rotationId)`. The client replaces its stored token only on that confirmation. Retries with the old active token remain valid throughout the pending phase. If the activation response is lost after the CAS, retain the prior hash for exactly 60 seconds so the old stored token can reconnect; the next activation replaces grace state. A duplicate ACK for the last activated rotation from its recorded server-side socket, on the same seat and within that 60-second grace window, re-sends the confirmation without changing state. ACK after grace, for another rotation, or from another socket is rejected. The pending candidate is not accepted during this interval.

An ACK is not itself an authentication credential and does not replace the socket lease or existing identity/ticket checks. Only the server-assigned socket identity on the current WebSocket is considered. Pending and activated rotation ids are compared for equality only; no client-supplied socket identity is trusted.

### Exact row state machine

One row remains keyed by `(session_id, seat_id)`. `token_hash` is the active credential hash. Pending and grace hashes are never implicitly interchangeable with it.

| State | Row predicate | Authentication |
|---|---|---|
| `ACTIVE` | No pending hash; `token_hash` is current | Active hash; also prior hash only before its exact grace deadline |
| `PENDING` | Pending hash/id/socket/expiry are set and expiry is in the future | Active hash and unexpired previous hash only; pending hash is always rejected. Pending metadata never blocks authentication with a valid active/grace credential. |
| `PENDING_EXPIRED` | Pending hash exists but `pending_expires_at <= now()` | Same authentication as `ACTIVE`; sweeper may clear pending fields. Expiry itself never blocks a valid credential. |

Transitions:

1. **Authorize and begin rotation:** `authorizeSeatSocket` takes the existing transaction/advisory lock and checks live lease before recovery exceptions. A live lease is the only cross-socket controller exclusion. Pending metadata is never consulted to refuse a valid active or in-grace previous token. Whenever an authorized socket obtains the seat after the prior lease is expired or no longer owned—whether by active/grace token, host approval, or solo-owner recovery—the transaction first aborts any other socket’s pending tuple by CAS on its exact `(pending_rotation_id,pending_token_hash,pending_socket_id)` and expired/no-longer-owned lease, then reserves this socket and may start its own rotation. Host-approved and solo-owner recovery keep their existing eligibility checks; pending metadata never substitutes for or blocks those checks. Generate token `Tn` and server-side UUIDv4 rotation id `Rn` (CSPRNG); CAS writes `pending_token_hash=sha256(Tn)`, `pending_rotation_id=Rn`, `pending_socket_id=serverSocketId`, and `pending_expires_at=now()+30s`, leaving `token_hash` unchanged. Pending expiry is cleanup, not an authentication lock. Cap rotation starts at 6 per seat in a 60-second window anchored at the first start (including host-approved and solo-owner paths), using the row’s window-start/count fields; reset the count only when that window elapses. At the cap, do not create another pending credential. A valid active-token socket remains authorized using its existing token and receives an explicit rotation-deferred indication, with no replacement token; a host-approved claim remains approved/admitted but has no new credential until it retries after the window. Thus pending abuse may consume at most six reservations per seat per window, but cannot make a valid old token fail authentication or turn a host approval into a denial.
2. **Send candidate:** send `SeatAuthenticated(Tn,Rn)` only after pending CAS succeeds. Send only on TLS (`wss`). On send failure or connection close, no active credential rollback/invalidation is needed. Best-effort clear pending fields using a CAS matching `(session,seat,pending_rotation_id,pending_token_hash,pending_socket_id)`; if that write fails, expiry/next valid-token takeover is authoritative cleanup.
3. **Client receipt ACK:** first check whether this is a duplicate ACK for the last activation (step 5); otherwise accept it only if the row still has exactly this pending rotation, hash, server socket id, unexpired pending deadline, and the socket still owns the live lease. ACK never authenticates by itself. If pending expired or a valid-token takeover already aborted/replaced it, reject the ACK.
4. **Activate:** in one transaction/CAS, verify that pending tuple and socket lease still match, copy active `token_hash` to `previous_token_hash`, set `previous_token_expires_at=clock_timestamp()+interval '60 seconds'`, set `token_hash=pending_token_hash`, set `rotated_at`, save `last_activated_rotation_id=Rn`, `last_activated_socket_id=serverSocketId`, and `last_activated_at=clock_timestamp()` in that SAME CAS, then clear pending fields. If no row matches, do not report activation. Send `SeatResumeTokenActivated(Rn)` only after commit.
5. **Duplicate ACK / grace:** while `last_activated_at` is within the previous-token 60-second grace window, a duplicate ACK matching the last activated rotation id and recorded server socket id on the same seat returns the same activation confirmation without changing any row state. An ACK from another socket, an older/different rotation id, or an ACK at/after the grace deadline is rejected. This durable idempotency record is replaced only by the next activation; its timestamp bounds acceptance.
6. **Grace end / next activation:** authentication accepts `previous_token_hash` only while `previous_token_expires_at > clock_timestamp()` and subject to the same live-socket-first policy; at the exact deadline it is rejected. A periodic sweeper clears expired previous fields. On later activation, previous hash is replaced by the then-current active hash. Never restore a previous hash on failed send or failed activation.
7. **Revocation/session deletion:** existing row deletion cascades remain authoritative and remove active, pending, grace, and activated-ACK metadata together.

All state transitions that change credential state use CAS predicates over expected rotation id/hash and server-side socket owner; activation and abort require an unexpired pending deadline. The authorization lock remains keyed by `(session_id, seat_id)` and is always taken before row decisions. A valid-token takeover aborts the other pending tuple in the same transaction before writing its own pending tuple. Expiry sweeps are bounded batches using `FOR UPDATE SKIP LOCKED`; they clear pending/grace metadata only and never promote a credential.

### Schema migration

Add the next free migration at implementation time (currently `0050`; do not reserve or hard-code this number in design artifacts): nullable `pending_token_hash text`, `pending_rotation_id uuid`, `pending_socket_id uuid`, `pending_expires_at timestamptz`, `previous_token_hash text`, `previous_token_expires_at timestamptz`, `last_activated_rotation_id uuid`, `last_activated_socket_id uuid`, `last_activated_at timestamptz`, `rotation_window_started_at timestamptz`, and `rotation_starts_in_window smallint NOT NULL DEFAULT 0`. Add checks requiring pending hash/id/socket/expiry to be either all NULL or all non-NULL; previous hash/deadline to be paired; last-activated id/socket/time to be all NULL or all non-NULL; rate-window start to be NULL exactly when its count is zero; and the rate count to be between 0 and 6. Add partial indexes on `pending_expires_at` where pending hash is non-NULL and `previous_token_expires_at` where previous hash is non-NULL. No credential backfill is needed: existing `token_hash` rows are active; new fields start NULL/defaulted. Keep existing PK, seat-revocation trigger, heartbeat-pair check, and 15-second lease semantics. Sweeper runs from the existing maintenance mechanism in bounded batches; correctness does not depend on prompt sweeping because authentication checks expiry directly.

### Alternatives considered

| Option | Assessment |
|---|---|
| **A. Pending hash, send, CAS activate (chosen)** | Pending is categorically excluded from auth. Keeps previous active hash until activation, so an activation write failure does not strand the player. Shared DB state handles multiple processes and restarts. ACK/confirmation and short old-hash grace address delivery/confirmation ambiguity. |
| **B. Persisted invalidation marker** | Rejected as primary fix: marker write uses the same database that already failed for rollback/invalidation. An outage can leave the marker absent. A marker can be useful operational metadata, but cannot establish safety here. |
| **C. Deliver then commit** | Better than current order if the server sends first and only commits after positive send completion: a failed commit leaves the previous hash active and a newly delivered token unusable, not a phantom valid credential. But it alone gives no durable in-flight identity, no safe ACK/retry semantics, and no distinction between callback success and client receipt; naïve client replacement can strand the device. The pending state plus CAS provides explicit ownership, bounded cleanup, idempotency, and auditable multi-process semantics. |
| **D. Keep both hashes valid until client ACK** | ACK alone is not enough. If the new hash is accepted before durable activation/confirmation, it reintroduces early validity; if both hashes are stored only as valid, old-token replay is widened. Use ACK to trigger pending-to-active CAS, with explicit old-hash grace after activation. Rotation does not revoke a stolen old token; seat revocation/session deletion does. |
| **E. Process-local fence or durable fence-only** | Rejected: process-local state is not shared; durable fence-only has the same database availability dependency and complicates rollback/takeover. Safety must follow from credential state, not a side marker. |

## Consequences and code sites

- `apps/server/src/gateway/resumeTokens.ts`: change `authorizeSeatSocket` to reserve pending rotation without overwriting active hash; make every authentication query match active hash (or explicitly unexpired grace hash), never pending; add begin/activate/abort/sweep operations around one row-level state machine. Prefer a small cohesive rotation interface over exposing each column choreography to `ws.ts`.
- `apps/server/src/gateway/ws.ts`: replace commit-before-send plus rollback/invalidate retries with pending reservation → `SeatAuthenticated` send → ACK handler → activation CAS → activation confirmation. Keep lease cleanup independent. A failed send/DB write must not set a process-local auth fence or change active hash.
- Client wire schema and token persistence: stage candidate token by rotation id; preserve old token until `SeatResumeTokenActivated`; retry ACK safely; discard an expired/aborted candidate. This protocol addition is required, not optional, for smooth activation-failure recovery.
- the next-free migration (currently 0050 at design time); migration tests and gateway tests in `apps/server/test/db/gateway.test.ts`; add a shared-DB two-gateway harness there or a focused adjacent suite.
- `seat_resume_tokens.token_hash` remains the sole active credential authority. Remove `unresolvedInvalidations`, `markSeatResumeTokenInvalidationPending`, `clearSeatResumeTokenInvalidationPending`, invalidation retry logic, and the lease-retention special case once migration/cutover is complete. Retain the #436 lease: it still prevents concurrent controlling sockets; its 15-second TTL is not used as credential revocation. Normal host-approved claim and solo-owner recovery still grant a new pending token and only rotate it after receipt ACK; recovery eligibility, owner cookie checks, and host approval remain unchanged. Cap rotation starts at six per seat per anchored 60-second window; the cap does not make pending metadata an authentication lock or reject a valid-token socket or approved claim. Initial seat token creation continues to establish an active server-generated token as today.

## Failure modes

“Attacker” means someone presenting a credential without the legitimate device; the table assumes no database compromise, XSS, or stolen account cookie. A send error is ambiguous about whether bytes arrived. **Rotation is not revocation:** the old token remains valid for the entire pending phase (up to its 30-second pending lifetime per attempt, with repeated starts limited to six per seat per anchored 60-second window) and the previous token remains valid for up to 60 seconds after activation. A stolen old token can therefore still be used during those windows, subject to the existing single-controller lease. Revoke a seat or delete its session to revoke credentials; token rotation alone does not kill a stolen token.

| Failure/crash point | Player sees / recovery | What an attacker can do |
|---|---|---|
| Pending-row write fails before send | No new credential; retry with existing token or host-approved recovery | Cannot use candidate; active token remains the only bearer credential |
| Send callback errors, pending clear succeeds | No confirmed new token; retry using old token | Candidate is never accepted; old token remains valid |
| Send callback errors and pending clear also fails | Client may have received candidate or may see close; retry old token; pending expires | Candidate remains non-authenticating on every process/restart; attacker cannot use it |
| Server crashes after pending write, before send | No token known to player; old token works after lease expiry; pending expires/sweeps | Candidate cannot authenticate |
| Server crashes during/after send, before ACK | Player may have staged candidate; old token remains valid; reconnect can retry using old token | Candidate cannot authenticate; old token is the intentionally active bearer |
| ACK received, activation CAS fails before commit | Client has staged candidate but retains old; retry ACK/rotation or use old token | Candidate cannot authenticate; old remains active |
| Activation CAS commits, process crashes before confirmation | Client may retain old; grace accepts old for 60s. A duplicate ACK from the same server socket and matching rotation id is idempotently confirmed before the grace deadline; if the client remains stuck past grace, it falls back to host-approved recovery. | New token is active; old token remains usable during its bounded 60-second grace. Rotation is not revocation. |
| Confirmation send fails after activation | Client keeps old; reconnect within grace succeeds with old. Same-socket duplicate ACK re-sends confirmation through grace; after grace, host-approved recovery is the fallback. | Same bounded old-token grace; no pending candidate can be replayed as a second active token. |
| Pending sweeper fails | Pending metadata remains until later sweep; expiry is checked synchronously | Pending candidate never authenticates |
| Grace sweeper fails | Expired grace hash remains stored but expiry check rejects it | No additional replay window beyond configured deadline |
| Two gateway instances share DB; one crashes/restarts | Both see the same active/pending/expiry state; client uses old or confirmed new token | No instance can authenticate pending candidate; no process-local fence is required |
| Old socket stalls beyond 15s while its pending rotation exists; valid old-token socket reconnects | After lease expiry, the valid active/grace token is accepted; its transaction CAS-aborts the prior socket’s pending tuple and starts a fresh rotation. Pending metadata adds no denial interval beyond the 15-second lease. | Candidate from aborted pending rotation remains non-authenticating; stale ACK/activation fails its tuple CAS. |
| Wrong-socket or expired ACK | No activation; use the still-valid old token or retry host-approved recovery if appropriate | Cannot activate a pending candidate or alter active state |
| Rotation start cap reached | Valid-token socket remains authorized on its existing token and receives a rotation-deferred indication; approved claim remains admitted without a new token and can retry after the window | At most six pending starts per seat per anchored 60-second window; pending abuse cannot make a valid old token fail or turn host approval into denial |
| Host-approved claim or solo-owner recovery | Existing policy authorizes claim; candidate is pending until ACK/activation; prior active token remains usable during transition | Claim policy unchanged; the newly pending token itself cannot bypass policy |

## Test plan (failing-first)

1. Unit/DB tests prove that a stored pending hash is rejected by `authorizeSeatSocket` for presented-token, tokenless, host-approved, and solo-owner paths; active hash still authorizes as appropriate; expired pending metadata does not become valid and never blocks a valid-token reconnect.
2. Gateway regression injects failure at pending write, send callback failure/throw, pending cleanup failure, activation failure before commit, and confirmation-send failure. Assert old-token continuity and candidate rejection or grace behavior, with no plaintext/hash in logs.
3. Crash/restart test: create pending row, destroy gateway instance, create a fresh instance against same DB after lease expiry, and prove pending credential remains rejected. Include crash after successful send but before ACK and after activation commit but before confirmation.
4. Two-process simulation: two independent gateway instances with separate in-memory state and one Postgres DB race the same old token/pending ACK. Exactly one activation wins; stale rotation IDs and socket IDs cannot activate; no instance accepts the pending hash. Repeat with first instance discarded/recreated.
5. Concurrency/race tests for expiry sweeper versus ACK, pending replacement, lease heartbeat expiry, revocation, host-approved claims, and solo-owner recovery. Verify an old-token reconnect aborts another socket’s pending tuple after lease expiry; verify old-hash grace is rejected at the exact 60-second boundary and never overwrites a newer active hash.
6. ACK tests: duplicate ACK after activation re-sends confirmation without a write; ACK after pending expiry, ACK from the wrong socket, stale/other rotation id, and duplicate ACK at/after grace expiry are rejected. Test the 60-second grace boundary and a client stuck after grace falls back to host approval.
7. Rotation-rate tests prove the six-per-seat-per-anchored-60-second-window cap (including host-approved claims), reset-at-boundary behavior, and verify reaching the cap does not reject valid-token authentication or an approved claim; no more than six pending starts are admitted in the window and deferred rotation is explicit on the wire.
8. Client protocol tests stage token, preserve old token on no confirmation, ACK idempotently, atomically replace only on activation confirmation, and recover when confirmation is lost. Assert wire schemas reject malformed/stale rotation IDs and only TLS transport carries candidates.
9. Migration tests verify legacy rows become `ACTIVE` with NULL pending/grace/activation fields, default rate counter, checks/indexes exist, and SeatRevoked/session deletion clears all credential slots.

Do not count a test that merely spies on a helper as a multi-process test: both gateway instances must execute the production authorization/activation implementation against the same database. Run the DB suite, migration suite, typecheck, formatting, and full required CI on the implementation PR.

## Rollout and estimate

Docs-only decision; implementation estimate **M/L** because it spans server persistence/gateway, client protocol/token persistence, migration, and race tests.

1. Ship the additive migration first; assign its actual number as the next free migration at implementation time (currently 0050). The migration is additive and per-deployment configuration controls the flag.
2. **Hard cutover prerequisite:** upgrade every gateway instance to the new binary before enabling `SEAT_RESUME_TWO_PHASE_ENABLED` for the deployment. New and old binaries must never serve the same seats during cutover: old binaries overwrite `token_hash` without respecting pending/grace/activation metadata. Drain old instances and connections; no mixed fleet is supported, even while the flag is OFF.
3. Deploy the new server/client implementation with the deployment-wide flag default OFF; only after fleet convergence enable it. No compatibility window may route a seat to an old binary.
4. Enable in staging, then production; monitor pending expiry, activation CAS misses, old-token grace use, rate-cap events, and host-approval fallback without logging credentials or hashes.
5. Enable globally after two-gateway/restart and client-upgrade coverage is green. Remove the legacy commit/rollback/invalidation/fence branch once the flag is permanently ON, then remove the flag.
6. Migration down is not supported after two-phase rows are used. A code rollback requires disabling the feature only after all instances converge to a rollback binary and safely handling pending rows; it must not recreate a mixed fleet or silently re-enable the old residual.

## Plain-language explanation for the owner (10 lines)

1. Today the server saves a new password before it knows whether the player received it.
2. If sending fails, the server tries to undo that save.
3. If undo also fails, the database can keep a password the player may never have seen.
4. A temporary safety list in one server process blocks it only there.
5. A restart or another server process does not have that list.
6. The fix is to save a new password as “waiting,” not as usable.
7. The server sends it, and the player confirms receipt.
8. Only then does one database update make it the active password.
9. If anything fails earlier, the old password still works and the waiting one never does.
10. That rule is stored in the shared database, so restarts and other servers follow it too.

## Verification

This is a proposed design, not implemented behavior. Source reviewed: PRs #436, #441, and #444, including owner/security review comments; `apps/server/src/gateway/ws.ts`; `apps/server/src/gateway/resumeTokens.ts`; migrations 0038–0040 and 0039 socket-lease changes; and relevant tests in `apps/server/test/db/gateway.test.ts`. Implementation acceptance requires the failing-first plan above and green CI; this ADR does not claim those checks ran.
