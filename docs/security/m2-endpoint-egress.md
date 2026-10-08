# M2-19 outbound endpoint guard: threat model and runbook

Code: `apps/server/src/llm/egress.ts` (guard), `llm/secret.ts` (key wrapper), `config.ts` (env). Tests: `apps/server/test/llm/egress.test.ts`. ESLint forbids `fetch`, `node:http(s)`, `node:net`, `undici` anywhere in `apps/server/src/llm/` except `egress.ts`; a test repeats that check.

## Threat
The operator supplies the LLM base URL, so the server fetches an operator-chosen host. A misconfigured or compromised operator/config (or a URL copied from untrusted text) could point it at cloud metadata (credential theft), internal services, or loopback admin ports (SSRF), or leak the API key to an attacker host.

## Policy (every adapter call)
- Scheme `https` only. `http` only for a host on the operator allowlist. No userinfo. Public hosts: port 443 only. Allowlisted hosts: any port.
- Address classes: `public` always ok; `local` (loopback, RFC1918, CGNAT, ULA `fc00::/7`, benchmark/doc ranges) only for an exact allowlisted hostname/IP; `blocked` never, even if allowlisted: `0.0.0.0/8`, `169.254.0.0/16` (incl. 169.254.169.254), `100.100.100.200`, `168.63.129.16`, `192.0.0.192`, `fe80::/10`, `fd00:ec2::254`, multicast/reserved, `::`, Teredo, unparseable input, names `metadata.google.internal`/`metadata`/`instance-data`.
- IPv4 inside IPv6 (`::ffff:a.b.c.d`, `::a.b.c.d`, `64:ff9b::/96`, `2002::/16`) inherits the embedded IPv4 verdict. Decimal/octal/hex/short IPv4 are normalized by the WHATWG URL parser before classification.
- DNS: resolved once per request; **all** answers must pass (mixed sets refused); the transport connects to that exact validated address (Node `lookup` override; TLS SNI/Host stay the hostname), so there is no second lookup to rebind.
- Redirects: any 3xx is refused, never followed (so no per-hop bypass).
- Limits: 60 s total timeout, 8 MiB response cap (enforced while streaming), both overridable in code.
- Allowlist: `LLM_ALLOW_LOCAL_HOSTS` (comma-separated exact hosts, empty by default). Local model example: `LLM_ALLOW_LOCAL_HOSTS=localhost` with base URL `http://localhost:11434/v1`.

## Not covered
- Resolver-level attacks outside the process (poisoned recursive resolver for a *public* name pointing at a public attacker IP): allowlisting public hosts is not implemented.
- A hostname allowlisted by the operator is trusted for every address it resolves to except blocked ones (e.g. an allowlisted name that later maps to another internal host).
- Proxies: `HTTP(S)_PROXY` is not honored by the transport (direct connect only).
- Malicious *response content* (prompt injection) is out of scope here (ADR-004/007).
- HTTP/2, keep-alive pooling and egress firewalling at the network layer; recommend a deny-by-default egress rule for metadata on the host as defense in depth.
- Wiring `createEgressGuard` into the production composition root: no code constructs the adapter yet (M2-14 is library-only); the next integrator must pass `createEgressGuard({ allowLocalHosts: config.LLM_ALLOW_LOCAL_HOSTS })` — the adapter's `egress` field is required, so it cannot be omitted.

## Secrets
- Source for legacy environment-backed deployments: `LLM_API_KEY`. Operator-configured endpoint keys are encrypted in `operator_endpoints.encrypted_key`; the AES-256-GCM master key is supplied as `OPERATOR_ENDPOINT_MASTER_KEY` (32 bytes encoded as 64 hex chars or base64) by the deployment secret manager. It is required in production and must never be stored in the DB, repo, or client payloads. No API returns a key; the API exposes only `keySet` and a 12-hex-character SHA-256 fingerprint.
- In memory: wrapped in `Secret` at config load; `toString`, `toJSON` and `util.inspect` yield `[REDACTED]`; only `OpenAICompatibleAdapter.headers()` calls `reveal()` to build the `Authorization` header.
- Logs: pino redact paths include `apiKey`, `*.apiKey`, `LLM_API_KEY`, `*.LLM_API_KEY`, `req.headers.authorization`, `req.headers["x-api-key"]`. Endpoint error bodies are discarded (adapter) and `EgressError` messages are fixed strings (no URL, headers, or body).
- Legacy `LLM_API_KEY` rotation: set the new value in the secret store, restart/redeploy servers (rolling), confirm via the adapter probe, then revoke the old provider key.
- Operator-key master rotation: the envelope is `v1.<key-id>.<nonce-base64url>.<tag-base64url>.<ciphertext-base64url>` (12-byte random nonce; AES-256-GCM authentication tag). Configure `OPERATOR_ENDPOINT_MASTER_KEY` as a comma-separated keyring of `id:base64-or-hex` entries; set `OPERATOR_ENDPOINT_ACTIVE_KEY_ID` to the key id used for new writes. To rotate, add the new key while retaining the old key, set it active, then run a controlled re-encryption migration that decrypts each envelope using its embedded key id and writes it with a fresh nonce under the new id. Verify envelopes and fingerprints, then remove the old key. A wrong key or tampered ciphertext fails closed and keys are never returned. Audit rows store only slot/action and expire after 30 days.
