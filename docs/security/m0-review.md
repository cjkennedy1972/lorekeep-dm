# M0 scoped security review

Reviewed commit `e1ae1b5eb816c4526ec19ea3338a08e755ea64f8` (2026-10-06). Static review only; findings ordered by severity. Paths below are repository-relative.

## Findings

1. **High — WebSocket access survives session revocation and account deactivation.** `apps/server/src/gateway/ws.ts:59,128`; `apps/server/src/gateway/tickets.ts:61`; `apps/server/src/accounts/reset.ts:64`; `apps/server/src/accounts/delete.ts:32`.
   Exploit: someone using a stolen session opens a room socket before the victim resets their password, revokes the device, or deletes the account. The socket keeps receiving room broadcasts and can request StateSync indefinitely: neither messages nor heartbeat recheck account/session validity. Unused tickets also survive ordinary logout/reset/device revocation and are not bound to the originating auth session; eligibility only checks room membership.
   Minimal fix: bind tickets and connections to an auth-session identifier; check active account/session on consumption and periodically/on messages; publish revocations to close affected sockets across nodes. Deletion must close existing sockets too.

2. **High — Compose exposes a database with public default credentials.** `infra/docker-compose.yml:5-9`.
   Exploit: when this Compose stack runs on a machine whose published port is reachable, a remote peer can connect to port 5432 with the checked-in lorekeep credentials and read/change accounts, password hashes, sessions and game data. The PostgreSQL image initializes POSTGRES_USER as a privileged database user.
   Minimal fix: bind development publishing to `127.0.0.1:5432:5432` (or remove publishing), require a nondefault secret outside local development, and use a separate least-privileged application role. Actual host/network reachability **needs test**; unsafe publishing configuration is verified.

3. **Medium — Login throttling does not bound expensive work or password spraying.** `apps/server/src/routes/auth.ts:135-154`; `apps/server/src/accounts/password.ts:18-22`.
   Exploit: an unauthenticated client repeatedly submits login attempts, including after lockout; every attempt still performs Argon2 verification before the 429 decision. Rotating email addresses also avoids the only counter (IP+email), allowing password spraying and growing a failures Map that never evicts expired keys. Process-local counters multiply the allowance across replicas.
   Minimal fix: enforce separate bounded IP and account limits before expensive verification, add global/concurrent Argon2 work limits, evict expired entries, and share limits across replicas. Keep nonexistent-account handling uniform within admitted requests.

4. **Medium — Production accepts the unprefixed development session cookie.** `apps/server/src/accounts/sessions.ts:12-18`.
   Exploit: an attacker controlling a sibling subdomain can set a parent-domain `sid` cookie containing the attacker's valid session token. Production accepts it even though it only issues `__Host-sid`; a victim without that cookie can unknowingly operate in the attacker's account (session swapping). Cookie ordering can also let injected sid shadow a real cookie.
   Minimal fix: in production parse only `__Host-sid`; accept `sid` only in explicit development/test mode. Reject ambiguous duplicate authentication cookies. This requires a sibling-domain cookie-injection foothold, not merely arbitrary cross-site JavaScript.

5. **Medium — Outstanding reset links remain valid after a password recovery/change.** `apps/server/src/accounts/reset.ts:48-67`; `apps/server/src/routes/auth.ts:270-277`.
   Exploit: an attacker obtains one unused reset link; the victim recovers using a different link or changes their password. Only the submitted reset token is marked used, and password changes invalidate no reset tokens, so the attacker can subsequently reset the password again until their link expires.
   Minimal fix: atomically invalidate all outstanding password-reset tokens for the account after either successful password reset or authenticated password change, with account-level serialization for concurrent resets.

6. **Medium — Unbounded room creation retains permanent per-room work.** `apps/server/src/routes/sessions.ts:82-106`; `apps/server/src/room/registry.ts:36-57`.
   Exploit: one verified account repeatedly creates rooms without a quota or rate limit. Every room allocates retained state and a 10-second lease-renewal timer; healthy rooms have no idle eviction. Database rows, heap usage, and background queries grow until shared service availability degrades.
   Minimal fix: enforce per-account room quotas and creation throttles, cap active rooms globally, and evict/release idle room actors with safe reload on demand.

## Checked and implemented correctly

- Passwords use Argon2id (19,456 KiB, two iterations); session/reset/verification/ticket secrets use 32 random bytes and SHA-256 storage; invites have 128-bit entropy.
- Verification/reset token consumption and WebSocket ticket consumption use conditional atomic SQL updates; room seating uses a serialized mailbox to enforce the six-seat limit within an actor.
- Reviewed SQL uses bound parameters; room/invite/session-revocation/export routes constrain access by authenticated ownership or membership. Export downloads additionally bind the signature to the stored job and expiry.
- Birthdate is evaluated server-side but omitted from account SQL and export fields; request logging excludes bodies and scrubs query strings/invite paths. Object-store keys cannot contain traversal separators; new files/directories request restrictive modes.
- Production refuses a missing AGE_RETRY_SECRET; WebSocket frames are capped at 64 KiB with compression disabled; CI uses pull_request (not pull_request_target) and contains no untrusted expression interpolation into shell commands.

## Verification and limits

Ran `which git node`, `ls /tmp`, the authorized shallow clone, `git rev-parse HEAD`, and line-numbered reads of all requested files (room files skimmed). No server, tests, dependency scripts, host probes, or network calls beyond the clone; no tracked source changes. Report saved to `/tmp/sec-review/m0-review.md`.
Proxy/TLS/Host enforcement and real network exposure remain unverified; Fastify does not enable trustProxy here, so no X-Forwarded-For trust bypass was found. CI token permissions depend on repository defaults (no explicit permissions block). Deletion/retention workers, persistence fencing implementation, schemas, dependency advisories, and telemetry internals were outside the authorized file scope; no claims of verified purge or end-to-end log secrecy. Runtime exploit impact and concurrency behavior remain untested.

---
## Atlas triage (2026-10-06)
Reviewer: bastion on openai/gpt-6-astra (static, scoped, commit e1ae1b5). All six findings independently confirmed by Atlas:
1. HIGH WS survives revocation: **reproduced live** (after logout the socket stays open and answers Resync; an unused ticket minted before logout still connects; a `deleting` account's socket keeps working). -> M0-FIX-07
2. HIGH compose publishes 5432 on all interfaces with default creds: confirmed in infra/docker-compose.yml. -> M0-FIX-07
3. MEDIUM login throttle runs full argon2 verify even when blocked; failure map never evicted: confirmed in routes/auth.ts. -> M0-FIX-07
4. MEDIUM production accepts dev `sid` cookie alongside `__Host-sid`: confirmed in accounts/sessions.ts. -> M0-FIX-07
5. MEDIUM only the submitted reset token is consumed; other outstanding reset links stay valid: confirmed in accounts/reset.ts. -> M0-FIX-07
6. MEDIUM unlimited room creation with permanent actors/timers: confirmed by reading routes/sessions.ts + room/registry.ts. -> M0-FIX-07
Out of scope / unverified by the review: proxy/TLS/Host behavior, deletion workers (M0-19), dependency advisories, telemetry internals.

## Invite link recovery (card 316f34f0)
Invites stay hash-only at rest (M0-FIX-07), so the plaintext cannot be re-fetched after a reload. Chosen design: the code is shown only from the response that minted it (create/regenerate; create hands it to the lobby via router state, cleared from history immediately). After a reload the host sees an explanation and a "Create new invite link" button; regenerating replaces the hash and invalidates the old link. No server change.
