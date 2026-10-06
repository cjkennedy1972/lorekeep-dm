# ADR-002: One single-writer Room actor per session, leased to a node

Status: Proposed (default) · Date: 2026-10-06

**Context.** Spec §6.2 needs serialized inputs and one in-flight DM turn per session; sessions must not affect each other.

**Decision.** Each session is an in-process actor with a serial mailbox. Placement via a Postgres lease row (`session_id, node_id, expires_at`), heartbeat-renewed; gateway routes sessions stickily. On node loss the lease expires and any node rehydrates from snapshot + log tail.

**Alternatives.** Redis pub/sub with a stateless fleet (more moving parts, need distributed locking); Durable Objects (see ADR-001).

**Consequences.** No locks inside a session. Failover cost = in-flight turn only. Load test required (M5).

**Needs human?** No.
