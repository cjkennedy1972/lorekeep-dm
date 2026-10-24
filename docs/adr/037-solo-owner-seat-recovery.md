# ADR-037: Solo owner seat recovery stands in for host approval

Status: Proposed · Date: 2026-10-23 · Owner: Sage · Depends on: ADR-014, ADR-029, ADR-031

Append-only: this ADR amends ADR-031 §3.5 and §3.6 without editing ADR-031. If this ADR conflicts with those sections, this narrow solo-session exception governs. All other ADR-031 reconnect rules remain unchanged.

## Context

ADR-031 §3.5 and §3.6 require a current seat resume token or host approval before a socket can control a seat. A ticket alone is never sufficient. That rule protects a seat in a shared table: the host can distinguish the owner returning from another party attempting to take over.

PR #278 allows a verified solo owner to reclaim their own seat without the resume token or host approval. After restart or in a fresh browser context (including a new device), the owner may have no token; a solo table has no other host to approve the claim. The owner’s authenticated account session remains available. This is a deliberate, narrow deviation from ADR-031, not an interpretation of its existing token rule.

## Decision

**Shipped default: OFF.** Recovery is disabled by default and remains disabled until the owner explicitly confirms this exception. The implementation exposes a named setting (for example, `soloOwnerSeatRecoveryEnabled`) whose default is `false`; enabling it is an explicit product-security decision, not an automatic consequence of merging PR #278. When false or unset, the existing ADR-031 §3.5–§3.6 token-or-host-approval rules apply without exception.

### 1. Solo owner recovery exception (amends ADR-031 §3.5)

A socket may recover a seat without presenting its current resume token or receiving host approval only when every condition below is true:

1. The table is an active solo session: it has exactly one seat and has not been converted to a party session.
2. The authenticated account on the ticket is the session owner account.
3. The target seat is that session’s owner seat, and the event history contains `SeatJoined` for it with no later `SeatRevoked` event.
4. The live-socket check runs first. A healthy first socket, as defined by ADR-031 §3.6, is never displaced by this exception. Recovery is considered only when the existing socket is closed or declared lost.
5. All other ADR-031 §3.5 checks pass: the ticket is valid and not revoked, the seat is still seated and not retired, and the ticket account owns the seat. The connection still receives control only after the check; the client remains read-only until snapshot acknowledgement under ADR-031 §3.1–§3.2.

The server determines solo status, ownership, and seat history from authoritative session/seat state. Client claims or flags cannot invoke the exception. No resume-token value is accepted or required for this path. On success, issue a fresh resume token and rotate the server-side stored hash as on an authenticated connection under ADR-031 §3.6. The recovery ticket MUST be single-use and bound to both the target seat and the authenticated session; reject reuse or any seat/session mismatch. The recovered socket becomes the seat’s single controlling socket and the server MUST emit `SeatTakenOver` immediately under ADR-031 §2.8, exempt from coalescing, with a notice delivered to the owner's other device/connections. This is not a general valid-ticket reconnect rule.

A seat that has any later `SeatRevoked` event is ineligible even if the account still owns the session. Revocation remains terminal under ADR-031 §2.7. A party seat is never eligible, including a seat owned by the session owner.

### 2. Threat model and rationale

The authenticated session is an adequate substitute for host approval only in this scope because minting the WebSocket ticket already requires the session owner’s authenticated account cookie, and there is no second party or host whose seat needs protection in a solo session. The exception does not elevate a different account or grant access to a party seat.

The relevant threats are:

- **Stolen session cookie:** already grants the attacker access to the account session and the ability to mint a ticket. Under this exception, the attacker can take over the owner's closed solo seat and rotate its resume token, locking the owner's old device out. This is an accepted residual risk contingent on explicit owner confirmation; session-cookie protection remains essential.
- **XSS on the origin:** can act with the victim’s authenticated session and is not prevented by requiring the resume token, which is available to the same browser context. Existing origin and session protections remain necessary.
- **Leaked unused ticket:** ADR-014's WebSocket ticket is minted for the owner's authenticated account and is a bearer credential. If an unused ticket is leaked within its 30 s TTL, that ticket alone is sufficient to satisfy the ticket-account match (because it is minted for the owner account), but the recovery request still requires the authenticated owner cookie session; the leaked ticket plus that session can reclaim the owner's CLOSED solo seat (subject to the other checks and controls below). The recovered socket consumes the ticket, rotates the resume token, emits `SeatTakenOver`, and notifies the owner's other device/connections, but the attacker can still lock out the owner's old device. This is an accepted residual risk contingent on explicit owner confirmation. Party seats remain ineligible.

These assumptions do not make session-cookie theft, XSS, or ticket leakage harmless. They bound the additional recovery authority to the same account and its solo seat.

### 3. Controls retained (amends ADR-031 §3.6)

The exception retains all controls that do not depend on host approval or possession of the old token:

- At most one controlling socket per seat; a healthy first socket is never displaced.
- A successful recovery rotates the resume token. The token remains 128-bit random, server-generated, stored only as a server-side hash, and delivered only over the authenticated socket, never in a URL.
- ADR-031 §3.6 transport limits remain mandatory: at most 5 socket-authentication attempts per minute per seat, including recovery attempts, plus per-IP and per-account limits.
- Ticket validity, expiry, revocation, owner-account matching, and live seat status are re-checked at control grant under ADR-031 §3.5.
- `SeatTakenOver` is emitted immediately on recovery as required by ADR-031 §2.8 (not coalesced), and the owner's other device/connections receive a takeover notice.
- Snapshot acknowledgement and read-only restore behavior remain unchanged under ADR-031 §3.1–§3.2.

The 60 s host-approval window remains in force for party-seat claims and any other claims outside this exception.

### 4. Solo-to-party conversion

If solo-to-party conversion is added, it must atomically end solo recovery eligibility before the first additional seat is admitted. The conversion records the session as party-mode; from that point forward every seat, including the original owner seat, uses ADR-031 §3.5–§3.6 token-or-host-approval rules. Conversion must not leave an interval in which a second seat exists while the owner seat can still use the solo exception. Existing connected sockets are not forcibly disconnected by this decision, but every subsequent reconnect uses the party rule. Conversion must preserve the one-active-socket and token-rotation controls.

### 5. Acceptance tests

The implementation must prove the following at the authenticated control-grant seam:

- **Stale token:** an owner of an active solo session with a stale token can recover when no live socket exists; the old token is not reused, and a new token is issued/rotated.
- **Missing token:** the verified solo session owner can recover without a token when no live socket exists.
- **Revoked seat:** the owner cannot recover a seat with a later `SeatRevoked`, even with a valid account session and ticket.
- **No owner cookie session:** a recovery attempt without the authenticated owner cookie session is refused and does not consume/grant control.
- **Single use:** a ticket already consumed at control grant is refused on replay.
- **Bindings:** a ticket bound to a different target seat or authenticated session is refused.
- **Grant notifications:** a successful grant emits `SeatTakenOver` immediately (not coalesced) and delivers the owner notice to other device/connections.
- **Party seat:** a party seat is refused without its current token or host approval, including when the claimant is the session owner.
- **Feature flag off:** with the named setting unset/default false, or explicitly false, tokenless recovery is refused and ADR-031 §3.5–§3.6 remain in force.
- **Healthy socket first:** a second socket cannot displace a healthy first socket, even for the solo owner and even with a valid ticket; recovery never displaces a live healthy socket.
- **Limits and restore:** repeated authentication is still subject to ADR-031 §3.6 rate limits, and successful recovery remains read-only until snapshot acknowledgement.

## Alternatives considered

- **Require a resume token for every reconnect.** Rejected for active solo sessions: restart or a fresh browser context can lose the only token, leaving the owner unable to reclaim the seat with no host available to approve.
- **Allow any valid ticket to recover any owned seat.** Rejected: this would erase the party-seat protection in ADR-031 and make ticket possession alone sufficient there.
- **Auto-approve owner claims in party sessions.** Rejected: other participants need a distinct host approval path when a seat token is missing.

## Consequences

- The owner of an active solo session can recover across restart and browser-context changes using their verified account session.
- The party-seat rule remains unchanged: token or host approval is required, and a healthy first socket cannot be displaced.
- ADR-031 remains historically intact; this ADR is the explicit, narrow amendment readers must apply.
- A future solo-to-party feature must switch off solo recovery atomically before admitting another seat. Recovery is shipped disabled by default until the owner confirms the exception.

## Product-security decision needed

**Needs owner confirmation:** accept the solo-owner recovery exception in the narrowed form described here, including the accepted residual risk that an UNUSED leaked 30 s ticket is itself sufficient to satisfy the account-match check because it is minted for the owner account; recovery additionally requires the authenticated owner cookie session, so the leaked ticket plus that session can take over the owner's closed solo seat, rotate its token, and lock out the owner's old device. Mitigations are single-use consumption at control grant, 30 s TTL, seat-and-session binding, immediate `SeatTakenOver` and notice to other device/connections, plus the existing rate limits. **Shipped default: OFF** via the named setting, defaulting to false; it remains OFF until owner confirmation. If not confirmed, ADR-031 §3.5–§3.6 continue to govern without exception. Required controls: recovery only for the active solo owner seat and matching authenticated account/session; no recovery after revocation or party conversion; never displace a live healthy socket; ticket is single-use, 30 s TTL, and bound to the target seat and session; emit immediate `SeatTakenOver` and notify the owner's other device/connections; enforce the existing 5 socket-auth attempts/minute/seat plus per-IP and per-account limits; rotate the resume token; keep snapshot-ack/read-only restore. Acceptance tests for cookie-session refusal, replay refusal, binding mismatches, grant notifications, healthy-socket preservation, and flag-off refusal are required before enabling.

## Verification

- Docs-only change: one new file, `docs/adr/037-solo-owner-seat-recovery.md`. ADR-031 and all other existing ADRs are unchanged.
- The acceptance tests above are required of the implementation; they were not run for this docs-only decision record.
- Source reviewed: ADR-031 §2.7, §3.1–§3.6; this ADR records PR #278’s stated solo-recovery behavior and the security choice required to authorize it.
