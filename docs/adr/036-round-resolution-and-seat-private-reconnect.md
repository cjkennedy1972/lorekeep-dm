# ADR-036: Round close facts and seat-private reconnect view

Status: Proposed · Date: 2026-10-23 · Owner: Sage · Work item: M4 round contract gaps found by real-server party e2e (#279) · Depends on: ADR-003, ADR-017, ADR-028, ADR-029, ADR-031, ADR-035

Append-only: this ADR adds contracts; it does not edit existing ADR bodies. It extends the persisted `RoundResolved` payload and WebSocket projections additively. Older persisted events remain valid.

## Context

The real-server party e2e identified three reconnect/authorization gaps in the round contract:

1. `RoundResolved` currently broadcasts `{roundId, actions}` and persists `{roundId, actions}`. `closeReason` (`all-submitted|timer|resolve-now`) exists only on the live round/snapshot. A client resyncing after resolution has no authoritative record of why it closed. The transient `RoundClosing` presentation is insufficient.
2. `publicRoundSubmission()` intentionally strips action text; `StateSync.round` therefore restores public progress but not the reconnecting player's own draft. The client edit box can be blank after reconnect.
3. Session/ticket and WebSocket admission require a current seat. An account whose seat was revoked or left receives a generic rejection/close and cannot render the spec's neutral “Not seated” state. It must not be given table contents as a side effect of learning this.

ADR-029 establishes one submission per `(roundId, seatId)`, editable through close and queued during resolution. ADR-003 makes the event log append-only and replay-authoritative; ADR-017/028 define the account-deletion scrub exception and retention. ADR-031 makes revocation immediate; ADR-035 prohibits account IDs in gameplay events and public payloads.

## Decision

### 1. Persist and broadcast the close reason

Add optional `closeReason: 'all-submitted' | 'timer' | 'resolve-now'` to both persisted `RoundResolved` event payload and its public WebSocket `RoundResolved.payload`, alongside `roundId` and `actions`. It is the immutable reason the round entered resolution, not a narration outcome. Populate it from the round's frozen close decision before persistence. Every close path, including host resolve-now and timer/all-in races, chooses exactly one reason in the Room mailbox; the winning transition determines the persisted value.

Replay treats the event as authoritative. New events always include `closeReason`; old events lacking it replay unchanged and clients render an unknown/unspecified close reason rather than inferring one from actions, timestamps, or current configuration. The same rules apply to snapshots/replayed streams. Do not rewrite historical events to backfill a guessed reason. The public enum is additive and the client parser accepts missing closeReason for old persisted events/older servers. This fact remains in gameplay history under ADR-017's gameplay retention clock.

`RoundResolved` carries no submission text or account identity. Its public `actions` remains the current thin projection. No `accountId` is added to any event or broadcast.

### 2. Deliver own submission in a seat-private reconnect projection

Add WebSocket server message `SeatPrivateRoundSync` with payload:

```
{ roundId: UUID, submission?: { actionId: UUID, text: string, queued: boolean } }
```

It is a targeted projection, not a Room event and not part of public `StateSync`. Send it after the authenticated connection has passed current-seat authorization, both on initial connection/resync and immediately after that seat's accepted/edit/queue/withdraw transition. It contains only the recipient seat's current live submission (round or queued); withdraw/no submission is represented by omission. The server derives seat identity from the authenticated connection, never from a client-supplied seat/account ID. The Room resolves one current submission per seat; `queued` distinguishes next-round queue state. The message is ephemeral and recomputed from authoritative Room state; do not persist a second copy or put it in event history. Existing canonical `RoundActionAccepted`/`RoundActionEdited` events remain the replay source and include text only under the existing server-side event privacy rules; the public round projection must continue stripping text.

The web reducer stores the private projection separately from public `RoundSnapshot`, keyed by roundId and the local connection lifecycle, and RoundPanel uses it to prefill/edit the owner's text. On `StateSync`, a newly computed private projection replaces/clears any stale one; on `SeatPrivateRoundSync` omission, clear the draft for that round. On `RoundResolved`, clear the private projection for that round after any needed local submission UI; queued content remains available for its next-round identity as the server promotes it. Do not optimistically restore unsent draft text from another seat or infer ownership from `playerName`.

Authorization is checked at send time and again when sending queued/resync data: valid authenticated ticket, current non-revoked seat, and seat ownership. A revoked or departed seat receives no private projection after revocation. The payload includes no account ID, display name, other seat's text, or other seat's action IDs. It is unicast to the authenticated socket; never broadcast, include in public snapshots, or echo into logs. Use the existing per-seat action-input mutation limits in ADR-029/032; reads/resync use the existing connection/resync rate limit, not a new text-submission allowance.

**Deletion/scrub.** Submission text is user-authored gameplay text and canonical event text follows the existing account-deletion redaction pipeline in ADR-017 and the narrow append-only exception in ADR-003/ADR-035: scrub the deleted author's text to `[removed]` (or the existing non-replayable redaction representation), preserving event sequence/type and non-identifying mechanics required for replay. `SeatPrivateRoundSync` is not stored and disappears with the connection; do not create a second durable copy or extend retention. Do not redact text solely because a seat leaves or is revoked; ordinary gameplay replay remains intact. No account ID is added to the event to enable this lookup; deletion resolves authored events via existing server-side ownership metadata/indexes.

### 3. Minimal revoked-seat response, no table disclosure

**Recommendation: provide a minimal machine-readable not-seated result; Needs owner confirmation.** The product should render a neutral “Not seated” state for an authenticated account whose membership has ended, rather than an inaccessible route or transport-only close. It must not restore an old seat's control or expose the table.

Add a read-only admission/status response for the table route, using the existing session identifier and authenticated account: current authorized seat proceeds normally; absent/revoked membership returns HTTP `403` JSON `{ code: 'not_seated' }`. This is deliberately identical for never-seated, left, kicked, banned, and revoked accounts, to avoid revealing whether a particular account previously held a seat or why it ended. The web table route maps only this code to the neutral Not-seated UI; no seat list, host identity, table title/state, event sequence, round/submission data, or account IDs accompany it. Unauthenticated callers remain `401`; nonexistent/invalid session behavior remains the existing generic not-found/invalid response and must not be made distinguishable by probing membership. For a connection that is revoked after WS admission, keep the current immediate close behavior; optionally send a typed `Error{code:'not_seated'}` immediately before close only if the close path guarantees no subsequent room event delivery. The HTTP response is the reliable route/reload path.

The status check uses current membership derived from authorized membership events/store, not stale browser state. It is read-only and cannot mint a WS ticket or reconnect the revoked seat. Invite/join flows remain separate and require their existing authorization. No new seat-specific or account-specific rate budget is introduced; apply existing authenticated HTTP rate limiting to this read endpoint. A `403 not_seated` response carries no reason subtype and no persistent event is emitted.

**Needs owner confirmation:** whether to ship this small neutral state as a product route outcome now, or leave revoked users at the existing generic denial until a broader admission UX is designed. Default recommendation is ship it: the single code reveals only that the requester currently lacks access, which the 403 already establishes, while allowing the client to render the spec's neutral state.

## Compatibility and migration

All changes are additive. New `RoundResolved` schema accepts missing `closeReason` for old events and older persisted records remain byte-for-byte unchanged. New clients accept both shapes; old clients ignore the new field under their existing unknown-field policy, or continue to receive a compatible `RoundResolved` shape. `SeatPrivateRoundSync` is a new discriminated-union message; older clients may ignore it and retain the existing submission behavior. New clients treat its absence as no private projection and must not fail to parse public `StateSync`. The `403 {code:'not_seated'}` remains an HTTP 403; clients that do not recognize the body keep their existing generic denial. No event backfill, migration, or rewrite is required.

## Ordered implementation breakdown and acceptance

1. **Forge — event/schema and Room close.** Extend persisted/public `RoundResolved` schemas, capture the mailbox-winning close reason, and preserve legacy replay. Acceptance: each close trigger persists and broadcasts the exact enum; a replayed old event without the field succeeds and is not guessed; two competing close triggers persist one winner only.
2. **Forge — private projection and authorization.** Add `SeatPrivateRoundSync`, emit only to the owning current seat on initial sync/resync and accepted/edit/queued/withdraw transitions; clear on revocation. Acceptance: real-server two-seat test proves each socket receives only its own text; reconnect restores own edit value; public StateSync and all-seat broadcasts contain neither text; forged seat ID cannot request another player's text; revoked seat receives none.
3. **Prism — reducer and RoundPanel.** Keep private state separate from public round state, restore the current draft in the edit box, and clear stale/withdrawn/resolved content correctly. Acceptance: reload/reconnect after accepted and edited action prefills exact own text; queued action is marked queued and survives reconnect; withdrawal and stale round projection clear it; no cross-seat text appears in DOM/accessibility tree.
4. **Bastion — neutral revoked-seat route.** Add authenticated minimal status/admission result and map uniform `403 not_seated` to the neutral view without exposing table data or allowing WS re-entry. Acceptance: kicked/left/never-seated callers see identical response; current seat still enters; invalid/unauthenticated behavior is unchanged; response has no table, seat, account, or revocation reason fields. **Owner confirmation required before treating this UI choice as final.**
5. **Proof — un-fixme PR #279 specs and privacy regression.** Un-fixme the three real-server party e2e specs covering resolved-round close reason after resync, own submission recovery after reconnect, and revoked/left seat's neutral Not-seated view. Assert exact `closeReason`, private per-socket delivery/no cross-seat leak, deletion scrub behavior, and uniform minimal 403 body. Record which spec is gated on owner confirmation; do not weaken the other acceptance tests.

## Consequences

A resynced client can explain completed round closure; the submitting player can recover its current text without making round text public; and revoked users can reach a neutral terminal view without recovering table access. This adds a targeted ephemeral private message and one uniform authorization response, while preserving append-only replay and existing deletion semantics. If the owner rejects the revoked-seat UI, retain the 403 denial and omit only that route/client slice; the event and private projection decisions remain independently useful.
