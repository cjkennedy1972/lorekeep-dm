# ADR-010: Single WebSocket per client for inputs, state patches, and token streaming

Status: Proposed (default) · Date: 2026-10-06

**Context.** Need presence, queued/ack states, roll events before narration, token streaming to all players, reconnect ≤ 3 s.

**Decision.** One WS per client. Messages: client→server `{actionId, type, payload, lastSeq}`; server→client sequenced events (`seq`), `StateSync` on connect/resync, `NarrationChunk`, `RollEvent`, and map events (`EntityMoved`, `AreaResolved`, `TerrainChanged`, ADR-018). The connection is authenticated with a one-time ticket derived from the account session (ADR-014). Idempotent by `actionId`; client reducer applies by `seq`, requests resync on gap. Heartbeat 10 s; away at 30 s.

**Alternatives.** SSE + POST (simpler streaming, but presence and bidirectional room events need two channels).

**Consequences.** Sticky routing required (ADR-002). Screen-reader live-region throttling is a client concern (announce per sentence, not per token).

**Needs human?** No.
