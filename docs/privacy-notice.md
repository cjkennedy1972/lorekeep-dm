**DRAFT FOR OWNER REVIEW — not for publication**

# Privacy notice: AI endpoint and retention (draft section)

Status: draft for M3-39. Covers only the AI endpoint and log retention parts of the notice. Account data (email, display name, adult flag and check date) and the rest of the notice are not drafted here. Every legal-adjacent sentence is marked `OWNER: confirm wording`. Nothing here is legal advice or a compliance statement.

## 1. What is sent to the AI endpoint

- Player-written text (messages and actions) is sent to the operator-configured AI endpoint so that the game master can narrate. <!-- OWNER: confirm wording -->
- The game master's narration and the session's content settings (content tier, table lines and veils) are part of the request to the endpoint. <!-- OWNER: confirm wording -->
- When the moderation classifier is enabled, player text and each output chunk are also sent to the endpoint configured for moderation. Its verdict decides whether text is shown. Classifier traffic goes to the operator's `moderate` endpoint, so player text is processed on operator infrastructure. <!-- OWNER: confirm wording -->
- Nothing is sent to a moderation provider by default. A third-party moderation adapter, if ever enabled by an operator, would be named here, and player text would be sent to it. <!-- OWNER: confirm wording -->

## 2. Which class of endpoint your operator uses

The operator configures the endpoint's base URL, model, API style and API key. The product does not store a "hosted" or "self-hosted" label. The endpoint class is set by the operator for each deployment:

- **Endpoint class for this deployment:** [OPERATOR TO SET: hosted third party | self-hosted]. <!-- OWNER: confirm wording -->
- A hosted third-party endpoint is a service run by a provider outside the operator's infrastructure. Player text is sent to that provider. <!-- OWNER: confirm wording -->
- A self-hosted endpoint runs on infrastructure the operator controls. Player text stays on that infrastructure, but the operator is responsible for the model's behavior and its data handling. <!-- OWNER: confirm wording -->
- The product allows an endpoint address that resolves to a loopback or private network address only if the operator lists that host in `LLM_ALLOW_LOCAL_HOSTS`. Plain `http` is allowed only for those hosts. Public addresses must use `https`. This check does not tell hosted and self-hosted endpoints apart, because a hosted service on a private network looks the same as a self-hosted one. <!-- OWNER: confirm wording -->

## 3. The operator is responsible for the provider's terms

- The operator chooses the endpoint and is responsible for that provider's terms, including its acceptable-use rules for mature content. <!-- OWNER: confirm wording -->
- Mature content is on by default unless a player at the table opts out. Mature means graphic violence, dark themes, strong language, and innuendo or allusion. Explicit sexual content is out of scope at every tier. Mature content is used only where the operator's endpoint is permitted to produce it under the provider's rules. <!-- OWNER: confirm wording -->
- The product checks the endpoint at setup with a probe, and the result sets a flag that controls whether the mature tier is allowed. If the endpoint refuses a mature prompt at runtime, that turn falls back to the standard tier and the flag is cleared. The flag is a technical check; it does not establish that the provider's terms allow mature content. <!-- OWNER: confirm wording -->
- The hard floor (sexual content involving minors, real-person harm, and instructions for real-world harm) applies at every tier and cannot be configured away. Output moderation runs independently of the model. It is a check, not a guarantee, and it fails closed: if the check cannot run, the content is held or blocked. <!-- OWNER: confirm wording -->
- The product does not use player content to train models. Whether a provider uses it for training is governed by that provider's terms, which the operator is responsible for. <!-- OWNER: confirm wording -->

## 4. How long data is kept

| Data | Kept for | Source |
| --- | --- | --- |
| Operational and safety logs, including LLM request and response logs and moderation decisions | 30 days from write, then deleted | ADR-017 |
| Reverted (rewound) turns | 30 days | ADR-017 |
| Game data (events, snapshots) | While the session is active; archived after 14 days idle; deleted 90 days after archive unless claimed | ADR-017 |
| Message reports | 90 days while open; 30 days after review or dismissal | ADR-017 |

Logs store IDs and decision labels where possible. Raw text appears only in the 30-day class. <!-- OWNER: confirm wording -->

Retention at the provider is the operator's responsibility and is not controlled by the product. <!-- OWNER: confirm wording -->

## Open questions for the owner

1. **Endpoint class.** The product has no hosted-or-self-hosted field. Should the operator declare the class in configuration, or should the notice simply ask the operator to state it? Section 2 assumes the operator states it.
2. **`LLM_ALLOW_LOCAL_HOSTS` format.** The brief describes a `host:port` form. The code matches exact hostnames or IP literals with no port (`apps/server/src/llm/egress.ts` lines 210-211, 244-245; `apps/server/src/llm/config.ts` lines 222-225), and local hosts are allowed on any port. Confirm which is intended before the notice describes the setting.
3. **Narration slot on `main`.** Solo narration still defaults to the `moderate` slot (`apps/server/src/room/productionTurnRunner.ts:153`). ADR-023 moves it to `fast` under M3-07, so the narration and classifier may share one endpoint until that lands. The notice's wording on where narration goes depends on which lands.
4. **Provider retention attestation.** ADR-017 says provider retention is "attested in endpoint config (ADR-013)". `config.ts` has no attestation field. Is one required, or is the statement in section 4 enough?
5. **Classifier wiring.** `apps/server/src/safety/moderator.ts` exists on `main`. The draft assumes the classifier is enabled in production. Confirm before publishing section 1.
6. **Provider terms for mature content.** The product cannot determine whether a given provider allows mature content. Who confirms this for each endpoint, and is it recorded anywhere?
7. **Status of ADR-017.** Its header reads "Proposed" (human decision recorded 2026-10-06). Confirm that the retention periods in section 4 are final.
8. **Training statement.** Section 3's "does not use player content to train models" comes from spec §9.5. Confirm it is a commitment the product will make publicly.
9. **Legal review.** Jurisdiction-specific requirements are parked in spec §13 and are not covered here. Counsel review is needed before any publication.
10. **Account data.** The sections on account data, export and deletion rights, and age checks are not drafted in this section.
