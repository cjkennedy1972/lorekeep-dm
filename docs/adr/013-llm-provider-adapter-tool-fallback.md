# ADR-013: Configurable LLM endpoints behind a provider adapter; tool-call capability detection with fallback modes

Status: Proposed (human decision 2026-10-06: endpoint is operator-configurable) · Date: 2026-10-06 · Amends ADR-009

**Context.** The operator must be able to point the product at any model: hosted (OpenAI-compatible or Anthropic-style APIs) or local (vLLM, Ollama, LM Studio, llama.cpp server). Models differ in tool-calling reliability, streaming-with-tools, context size, caching, and price. ADR-004 assumes typed tool calls; that cannot be assumed for every model.

**Decision.**
1. **Adapter interface** (`LlmAdapter`): `capabilities()` and `complete(request) -> stream of {textDelta | toolCall | usage}`. Request carries `role`, messages, optional tools or JSON schema, `maxTokens`, and optional `cacheHints`. Two dialects at launch: `openai-compatible` (chat completions) and `anthropic-messages`. Dialects are small translators; nothing above the adapter knows which one is in use.
2. **Operator config per tier**, `fast` and `frontier`: `{dialect, baseUrl, model, apiKeyRef, maxContext, timeouts, pricing{in,out,cacheRead?,cacheWrite?}, cachePolicy: none|auto|explicit, toolModeOverride?}`. Roles map to tiers: `narrate` routine, `summarize`, `classify` on `fast`; key scenes on `frontier`. `moderate` may be bound to a separate endpoint. Keys come from env or a secret store, never the DB, never sent to clients. Base URLs are operator-only (no user-supplied URLs, so no SSRF surface).
3. **Tool modes**, best to worst: `native` (tools API) > `json-schema` (structured output) > `prompt-json` (JSON in text, parsed and validated with the same zod schemas) > `engine-assist` (LLM only narrates; the engine provides an enumerated option list and the LLM picks an option ID, or the player's structured UI command is used directly).
4. **Capability detection:** an `adapter probe` battery (fixed synthetic scenarios, including invalid-argument traps and map-reference scenarios) measures valid-call rate, schema-violation rate, streaming-with-tools, and time to first token. Result is stored as an endpoint profile and selects the tool mode (threshold 0.95 valid-call rate is an assumption to calibrate). Probe runs at config time and on demand, never per player request.
5. **Runtime circuit breaker:** per session, a rolling tool-error rate above threshold drops one mode level and shows a neutral host notice. Orchestrator behavior on invalid calls is unchanged (2 retries, then safe narrated fallback, no state change).
6. **Option-selection protocol** (used in `engine-assist`, and optionally in combat for weaker models): the engine returns `legalOptions[{optionId, label}]` and the LLM must return an `optionId`. Cannot hallucinate IDs; costs one extra decision step.
7. Moderation endpoint gate: mature content (ADR-016) is unavailable unless the configured `moderate` endpoint has passed the red-team set (`moderationVerified`). The probe also records operator flag `endpoint_allows_mature`; if false (or the endpoint refuses mature prompts at runtime) the table degrades to `standard` gracefully.

**Alternatives.** Single provider SDK (rejected by decision 2). A generic proxy such as LiteLLM in front (extra service; may be used by an operator but is not required). Per-user bring-your-own key (key custody and abuse risk; not adopted).

**Consequences.** More test matrix: the recorded-LLM mode (ADR-012) must cover every tool mode. Latency and cost SLOs apply to a *reference configuration*, not to arbitrary endpoints. Weak local models get a degraded but safe experience because the engine, not the model, owns state.

**Needs human?** Yes: which endpoint is the reference configuration for SLOs, and minimum local-model class to support.
