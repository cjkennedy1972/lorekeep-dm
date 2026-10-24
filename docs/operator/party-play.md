# Party play (M4): operator and player guide

**Status:** Describes M4 behavior that has shipped on `origin/main`. Anything not shipped is listed under [M4 status](#m4-status) and is not described as available.

**Governing documents:** ADR-029 (round and chat contract), ADR-030 (rest vote), ADR-031 (presence, not shipped), ADR-032 (ADR-029 amendments), ADR-035 (seat character binding, schema only). Plan: `docs/plan/m4-breakdown.md`.

Where this page and an ADR disagree, the code wins for behavior, and the disagreement is listed in [Known discrepancies](#known-discrepancies).

---

## 1. Collect-then-resolve rounds (party rounds)

**What it does.** In a party table, each seat submits an action into an open round. The round resolves once, after all eligible seats have submitted, when the host resolves it, or when the timer expires. Actions are not resolved one at a time.

**Round states.** `open` → `resolving` → `resolved`. Resolve reasons are `all-submitted`, `timer`, or `resolve-now`.

**Who may do what.**

| Action | Who | Notes |
|---|---|---|
| Submit an action | Any seated account | Queued into the open round. |
| Edit a submitted action | The submitting seat | Limited (see below). |
| Resolve now | Host only | Rejected while the table is paused (`RoomPausedError`). |

**Limits (from code).**

- Queue: 3 queued actions per seat (`MAX_QUEUED_ACTIONS_PER_SEAT`), 12 per room (`MAX_QUEUED_ACTIONS_PER_ROOM`). Overflow is rejected with `ACTION_REJECTED`. (`apps/server/src/room/Room.ts`, ~L68–69)
- Mutation rate: 6 action mutations per seat per 60 s; 10 edits per seat per round. Exceeded → `ACTION_LIMITED` / `RATE_LIMITED` envelope. (`Room.ts` `reserveActionMutation`, ~L1572–1592)
- Round timer: default 120 s (`DEFAULT_ROUND_MS`). Allowed values are 30 s–600 s, or off (no deadline). Values outside that range are rejected with "Round timer must be between 30 and 600 seconds". (`Room.ts` ~L2107–2113)
- Resolve grace: `ROUND_GATE_GRACE_MS` = 5 s.
- A round resolves on `all-submitted` only when every non-away eligible seat has accepted an action. (`Room.ts` ~L2162–2169)
- If a round closes with no actions, the server emits `RoundClosedEmpty` and opens a new round without a DM turn.

**Player-visible messages.**

- Queue full or rejected action: `ACTION_REJECTED` envelope.
- Rate limit: `ACTION_LIMITED` / `RATE_LIMITED`.
- Not seated: "You're not seated at this table." (`apps/web/src/screens/Game.tsx` ~L495)
- Paused table: "The table is paused." (`Game.tsx` ~L142)
- Host timer save: "Round timer saved. It applies to rounds opened after this one." If the value was clamped in the UI: "…the nearest allowed value…" (`apps/web/src/features/round/HostControls.tsx` ~L83–99)

**Not done yet.** Presence-aware auto-away and autopilot (ADR-031, #278, in review). Until #278 ships, a disconnected seat still blocks `all-submitted` and waits for the timer or a host resolve.

---

## 2. Party chat (OOC) and moderation

**What it does.** Table chat is out-of-character. Every message passes a moderation pipeline before it is stored or broadcast.

**Pipeline order** (`apps/server/src/gateway/ws.ts`, `handleChat`, ~L1379–1580):

1. Origin check
2. Current seat and eligibility
3. Paused check (non-host rejected: "The table is paused.")
4. Mute check (`chat_mutes`)
5. Chat policy admission (burst, sustained, duplicate, non-allow strikes)
6. Table gate
7. Judge (deadline = min(5 s, 10 s minus elapsed))
8. Persist and broadcast only on allow

Every non-allow writes a moderation log entry.

**Limits (from code).**

| Limit | Value | Source |
|---|---|---|
| Message length | 2000 characters (server counts UTF-16 units; see discrepancies) | `packages/schema/src/ws.ts` `ChatSend` |
| Burst | 5 tokens, refill 1 per 2 s | `apps/server/src/chat/policy.ts` |
| Sustained | 40 messages per 10 min | `policy.ts` |
| Duplicate | Same text rejected within 60 s | `policy.ts` |
| Automatic mute | 3 attributable non-allows in 5 min → 5-minute mute | `policy.ts`, `chat/mutes.ts` |
| Host mute | Persists; automatic mute does not override it | `chat/mutes.ts` |
| Table gate | 40 calls per 60 s per table | `policy.ts` |
| Socket bucket | Capacity 20, refill 10/s | `ws.ts` (`MESSAGE_BUCKET_CAPACITY`, `MESSAGE_REFILL_PER_SECOND`) |
| Judge timeout | 4.5 s default | `apps/server/src/safety/moderator.ts` |

**Player-visible rejection.** Every chat rejection, whatever the reason, sends the same message: "That message could not be sent. Try again." (`CHAT_REJECTION`, `ws.ts` L55). Players are not told which rule fired. The paused and mute cases are the exceptions noted above.

**Who may do what.** Any seated account may send chat, unless paused (non-host) or muted. The host may mute and unmute a seat (`MuteChat`).

**Unverified: report-a-message UI.** Server report routes and `message_reports` retention exist (`apps/server/src/routes/reports.ts`), but the player-facing report flow in the web client was not verified and is not described here.

---

## 3. Host controls

All host commands are sent through the `hostCommand` envelope with `lastSeq`. Only the host may send them; others receive `NOT_HOST`.

| Command | Effect | Notes |
|---|---|---|
| `ConfigureRoundTimer` | Sets round timer (30–600 s or null for off) | Applies to rounds opened after the save. |
| `ResolveNow` | Resolves the open round now | Rejected while paused. |
| `KickSeat` | Removes the target seat and closes its socket (close code 1008, "Seat revoked by the host"). Emits `SeatRevoked` with `cause: 'host-kick'`. Host cannot kick their own seat. | Shipped behavior, which differs from ADR-031 §2.7 in three ways. (1) **Terminal per seat:** not implemented. The code removes the seat from `state.seats`; there is no `revoked` seat state, and the `cause` value is `host-kick`, not `kick`. (2) **Re-entry needs host approval:** implemented in the sense that nothing blocks the kicked account from calling `requestLateJoin` again, and admission still requires `ApproveLateJoin`. (3) **Ban at join request:** **not shipped.** No ban cause or ban check exists in `Room.ts` or `ws.ts`; a banned-account block is not available. Rest-vote N and counted-ballot retention for a kicked seat (ADR-031 §2.7) are unverified. |
| `TransferHost` | Moves host to another seated account | Fails with "Host transfer unavailable" if the target is not eligible. (`Room.ts` ~L2029) |
| `ApproveLateJoin` / `DenyLateJoin` | Decides a pending late-join request (`requestId`) | Approved requests are admitted at the next safe point. Events: `LateJoinRequested`, `LateJoinApproved`, `LateJoinDenied`, `LateJoinAdmitted`. |
| `EndTable` | Ends the table | Later mutations fail with "Table ended". |
| `PauseTable` | Pauses the table | Blocks non-host chat and resolve-now. |
| `MuteChat` | Mutes or unmutes a seat's chat | Host mutes are not overridden by automatic mute. |

Host command failures: `NOT_HOST`, `COMMAND_REJECTED`, `INVALID_ACTION`.

**Not verified in this pass.** The exact late-join eligibility rules (who may request, how many pending requests are allowed) and the kick and end-table rules beyond the envelope checks. Read `Room.ts` ~L1841–1960 and `ws.ts` ~L640–1000 before documenting those limits.

**Not done yet.** Late-join character entry (ADR-035). Players can request and be admitted, but they do not choose or create a character during the join flow.

---

## 4. Rest votes

**What it does.** A rest vote asks the party whether to take a short or long rest. Votes are decided by majority of eligible seats.

**Commands.** `CastRestVote { voteId, choice: 'yes' | 'no', kind: 'ballot' | 'tiebreak' }`.

**Close reasons** (`apps/server/src/room/restVote.ts`):

- `majority`: more than half of eligible seats voted yes (passed).
- `no-majority-early`: yes plus uncast seats cannot reach half (failed).
- `no-majority`: all seats voted, no tie, yes did not win (failed).
- `host-tiebreak`: all seats voted, tied, host cast a tiebreak.
- `tie-failed`: tie at the deadline or host revoked, with no tiebreak (failed).
- `expired`: deadline passed without majority (failed).
- `cancelled`, `cancelled-combat`: vote cancelled (failed).

**Who may do what.**

- Ballot: an eligible seat with presence `online`, an open connection, and the table not paused.
- Tiebreak: host only. Non-host: "Only the host may break a tie." (`Room.ts` ~L952). A tiebreak is only accepted when all seats have voted and the tally is tied.

**Player-visible errors.** `vote-closed` (late cast after close, replay returns stored status only), `ballot-not-allowed` (wrong seat state or not eligible).

**Vote deadline.** Set on open (`deadlineAt`). The numeric value was not verified in this pass; read the open path in `Room.ts` before stating it.

---

## 5. Six-client simulation harness

**What it is.** A scripted harness that drives six WebSocket clients against a real server, used to test party flows end to end (#272).

- Harness: `apps/server/test/sim/harness.ts`
- Scenarios: `apps/server/test/sim/dm.ts`, `apps/server/test/sim/spotlight.ts`
- Smoke test: `apps/server/test/db/sim-clients.test.ts`

**How to run.** The harness runs as part of the normal unit suite: `pnpm test` (root script runs `pnpm -r test`, which excludes `test/db`). Database-backed tests, including `sim-clients.test.ts`, need Postgres and run with `pnpm test:db` (requires `DATABASE_URL`).

**Blocked-content marker.** The harness gate rejects any text containing `BLOCKED-SIM`. Use it in scripted scenarios to exercise moderation rejection.

**Not verified in this pass.** Whether `spotlight.ts` exercises features that depend on #278, which is not on `main`. Check before running it as evidence of M4-4 behavior.

---

## 6. Retention

- Chat events (`chat.committed`, `chat.rejected`) carry an `expires_at` of 30 days after creation.
- Migration `0036_chat_expiry_tombstones.sql` adds `purge_expired_events(p_before)`. Expired chat events are tombstoned first (payload set to `{}`, `expires_at` cleared), then deleted. Sessions under a legal hold (`legal_holds`, kind `session`) are skipped.
- Chat reports (`message_reports`) follow ADR-028 clocks: 90 days while open, 30 days after review or dismissal, 90 days after.

---

## 7. Seat character binding (schema only)

Migration `0037_seat_character_bindings.sql` adds:

- `account_characters`: account-owned character records with `revision`.
- `session_seat_characters`: per-session seat binding with `character_snapshot`, `binding_status` (`active | released | redacted`), and one active binding per seat and per character.
- A trigger that blocks deleting an account character while it has an active seat binding.

Per ADR-035, `sessions.character_id` stays solo-only.

**Not shipped.** There is no player-facing character selection UI and no character entry during late join. Do not describe party character selection as available.

---

## M4 status

| Item | Status | PR | ADR |
|---|---|---|---|
| Party round lifecycle (collect-then-resolve) | Shipped | #268 | ADR-029 (header still "Proposed") |
| Moderated OOC party chat (M4-1) | Shipped | #266 | ADR-029, ADR-032 |
| Party lobby, round status, host controls (client) | Shipped | #271 | ADR-029 |
| Host-control UI wiring (M4-3c) | Shipped | #281 | ADR-029 |
| Rest vote and party quorum | Shipped | #273 | ADR-030 (header still "Proposed") |
| Six-client simulation harness | Shipped | #272 | — |
| Persist party seat character bindings (schema) | Shipped | #286 | ADR-035 (header "Proposed") |
| Resume party tables and sync rounds | Shipped | #280 | — |
| Presence, away autopilot, spotlight, resume tokens (M4-4) | **In review, not shipped** (draft) | #278 | ADR-031 (header "Proposed") |
| Combat turn and reaction orchestration (M4-6) | ADR merged; implementation not verified in this pass | #269 (ADR-033 docs) | ADR-033, ADR-034 (amendments, Proposed) |
| Character selection UI and late-join character entry | **Not started** | — | ADR-035 |

---

## Known discrepancies

Recorded here and in the PR body for the reviewer:

1. **ADR status headers are stale.** ADR-029, ADR-030, ADR-031, ADR-032, ADR-033, and ADR-035 still read "Proposed" (or "draft PR") though the code for some has shipped. ADR-031 is not shipped at all; the others are partly or fully shipped.
2. **Chat length counting differs.** Server `ChatSend` max is 2000 UTF-16 units. Web `ChatPanel` counts code points (`Array.from`). A 2000-emoji message can pass one and fail the other.
3. **Table gate vs ADR-032.** Resolved. ADR-032 §3 replaces the ADR-029 §8 shared pool with class budgets and sets at most 40 chat gate calls per minute per table, which matches `TABLE_GATE_LIMIT` = 40 in `policy.ts`. The doc now states the per-table limit as verified. The cross-table chat class budget (2 in flight, 120/min) is not verified against code.
4. **Paused-chat rule.** `ws.ts` rejects non-host chat while paused. Confirm this matches ADR-029/032 text.
5. **Round timer limits.** The 30–600 s range is enforced server-side. The web client clamps and shows a notice; the clamp is advisory.
6. **Kick semantics (ADR-031 §2.7).** Code removes the seat and emits `SeatRevoked` with `cause: 'host-kick'`. No terminal `revoked` state and no ban-at-join-request check exist. Ban is not shipped.
7. **Chat report UI.** Server report routes exist; the web report flow is unverified (see §2).

## Checks

- Behavior above was read from `Room.ts`, `restVote.ts`, `ws.ts`, `chat/policy.ts`, `chat/mutes.ts`, `packages/schema/src/ws.ts`, migrations 0035–0037, and the web host-control and game screens, at `origin/main` f00138a.
- Items marked "not verified in this pass" must be checked before this page is used as a source of truth.
