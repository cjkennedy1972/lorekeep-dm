# ADR-014: Required user accounts; email+password with server-side sessions; export and deletion

Status: Proposed (human decision 2026-10-06: accounts required) · Date: 2026-10-06 · Supersedes ADR-011

**Context.** Guests are gone. Every seat is an account, which gives abuse control, cross-device resume, age attestation (ADR-015). The Room actor model (ADR-002) is unchanged: identity is an `accountId` instead of a device-token `player_id`.

**Decision.**
- **Credentials (MVP):** email + password. Passwords hashed with **argon2id** (OWASP-recommended parameters, tuned to ~250 ms on the server class), per-user salt, optional breached-password check via k-anonymity range query. Email verification required before play. Password reset by single-use, 30-minute emailed token. Login rate limiting and temporary lockout per account and IP.
- **OAuth/OIDC** (Google, Discord) via authorization code + PKCE behind an `IdentityProvider` seam: P1, after launch of email+password. OAuth never replaces our birthdate age gate.
- **Sessions:** opaque random tokens stored hashed in Postgres (`auth_sessions`), httpOnly + Secure + SameSite=Lax cookie, 30-day sliding / 90-day absolute expiry, revocable per device. No JWT. CSRF: SameSite plus Origin check on mutating routes. **WebSocket auth:** the cookie authenticates a one-time short-lived (30 s) WS ticket; the Origin header is checked on upgrade.
- **Join links** remain per-session secrets with revoke/regenerate, but joining requires being logged in; an unauthenticated visitor goes login/signup then returns to the join.
- **Data collected:** email, password hash, display name, adult flag and age-check timestamp (ADR-015; birthdate is not stored by default). Nothing else.
- **Export:** authenticated (re-auth) async job writes a JSON archive (profile, characters, owned sessions, own submissions) to object storage; signed link valid 7 days; file deleted after.
- **Deletion:** user requests; account is deactivated and logged out at once; PII is hard-deleted within 30 days (ADR-017). Solo sessions are deleted. In shared sessions the character stays as an anonymized "departed adventurer"; the user's free-text submissions are redacted from retained events by the deletion job (the one sanctioned exception to log immutability, ADR-003).

**Alternatives.** Magic-link-only (simple, but email dependence on every login). Mandatory OAuth (excludes users without a supported provider account). JWT access tokens (revocation pain).

**Consequences.** Activation target (spec: 60% landing to first turn) is at risk from signup friction plus email verification; measure it. Email delivery becomes a hard dependency (transactional provider). Quick-start flow must create the account first, then character.

**Needs human?** Confirm OAuth is acceptable as post-launch; spec stories US-S1/US-P2 need amending by Compass.

**M0-14 CSRF addendum.** Cookie sessions use SameSite=Lax, which prevents cross-site POST/DELETE cookie attachment in modern browsers. Every mutating API request with an Origin header is also checked against the request's own scheme and Host; a mismatched or malformed Origin is rejected with 403. Requests without Origin remain possible for command-line and other non-browser clients; those clients cannot be induced by another website to attach the user's browser cookie. Cookie is host-only (`__Host-sid`, Path=/, Secure in production) and httpOnly. Deployments behind a proxy must configure Fastify's trusted proxy policy and Host enforcement before relying on forwarded scheme/host.
