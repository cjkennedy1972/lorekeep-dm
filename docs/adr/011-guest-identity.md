# ADR-011: Guest-first identity with device token; optional email claim later

Status: **Superseded by ADR-014** (accounts required; human decision 2026-10-06) · Date: 2026-10-06

> Superseded. Guest play and device-token identity no longer exist. Identity is an authenticated account (ADR-014), with age attestation (ADR-015). The text below is kept for history only.

**Context.** US-S1 (no account friction), US-S3 (resume across devices needs an account), A3, Q3.

**Decision (historical).** MVP: server-issued random device token (httpOnly cookie, hashed at rest) maps to `player_id`. Join links and 6-char codes are per-session secrets with revoke/regenerate. Account claim was P1. Rate limits per IP/session.

**Still carried forward into ADR-014:** join links and codes as per-session secrets with revoke/regenerate; rate limits.
