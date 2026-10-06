# ADR-011: Guest-first identity with device token; optional email claim later

Status: Proposed (default) · Date: 2026-10-06

**Context.** US-S1 (no account friction), US-S3 (resume across devices needs an account), A3, Q3.

**Decision.** MVP: server-issued random device token (httpOnly cookie, hashed at rest) maps to `player_id`. Join links and 6-char codes are per-session secrets with revoke/regenerate. Account claim (email magic link) is P1 and attaches existing `player_id`s. Rate limits per IP/session.

**Alternatives.** Mandatory OAuth at MVP (strong abuse control, hurts activation target of 60%).

**Consequences.** Weaker abuse controls and no cross-device resume until claim ships; moderation relies on session-level bans.

**Needs human?** **Yes**: guest-only acceptable for MVP? (Q3).
