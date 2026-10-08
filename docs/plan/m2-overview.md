# M2 overview: DM vertical slice (solo)

Status: proposal for human review. Source: spec §3, §7, §10; architecture §11 (M2 row); M0/M1 proof reports. Tickets: `docs/plan/m2-tasks.json` (42 tickets: forge 25, proof 6, prism 5, quill 2, sage 1, keel 1, bastion 1, sentinel 1).

## Goal

A signed-in user starts a solo game, gets AI-DM narration in about 3 minutes, plays adventure #1 including map combat, closes the browser, and resumes with a recap. The LLM only proposes tool calls; the M1 engine owns every number and position. The operator configures endpoints and probes them. M1's unproven items are closed or re-raised along the way (M2-01..07).

## Exit criteria

1. Quick start to first narration <= 3 min (recorded LLM, step timings in the report) (US-S1).
2. Adventure #1 completes via a keyboard-only scripted run, with a mid-run browser close and server restart that resumes with a recap (US-S3, US-B6, US-R2).
3. Probe picks `native` for one fake endpoint and `json-schema` for another, and refuses to mark an endpoint with neither (R-L2).
4. Live run of adventure #1 on the reference endpoint and on one local OpenAI-compatible model: evidenced, or marked NOT RUN with the reason (needs the human, Q1).
5. Eval harness v0 runs in CI in recorded mode and can set or withhold `qualified` (R-L4).
6. Carry-over closed: SRD geometry check, catalog reconciliation, levels 1-5 quick build, 6+ scenarios, Firefox/WebKit + axe (M2-01..07), each with a closure row.
7. Full gate (docs/process.md) green on a fresh clone; sentinel high findings fixed or accepted.

## Pushed out of M2

Spec lists these as P0; architecture §11 schedules them after M2 (M3 safety, M4 party, M5 hardening). I am proposing that they leave M2 for these reasons.

| Item | Spec | Why not M2 |
|---|---|---|
| Moderation, hard floor, X-card/pause, mature gate, rewind, report-a-message | §3.7, §7.6 | Whole milestone (M3). See risk 1 for the live-LLM gap. |
| Party play: invites into DM turns, collect-then-resolve, timers, away autopilot, drop-in, host controls, rest votes | §3.2, §6 | M4. M2's Room path is solo-only. |
| Solo companion NPC toggle (US-S2 AC2) | §3.1 | Shares controlled-NPC logic with M4 autopilot. |
| Freeform AI one-shot on catalog maps (US-M1 AC2) | §3.9 | Needs map-template tools; adventure #1 proves the path first. |
| SRD magic items (common/uncommon subset) | §8 | Not in catalog; adventure #1 loot uses equipment. |
| Fallback modes `prompt-json`, `engine-assist` | R-L2 | M5. Weak models are told "unsupported". |
| Adventures #2-#3, procedural maps, budgets/prices, load test, WCAG audit, retention e2e, SRD credits page polish | §8, §9 | M5. Attribution text itself is checked by M2-33. |
| Spectators, whispers, TTS, import/export, style presets | P1 | Phase 2. |

## Five biggest risks

1. **Real LLM text with no moderation until M3.** Open-ended model output reaches users before R-S1/R-S8 exist. Mitigation: live (non-recorded) DM turns are limited to operator allowlisted accounts until M3 (Q2).
2. **Tool calling on local/weak models.** `native` and `json-schema` may both fail on the local model; the exit criterion could be unmet. Mitigation: probe reports it plainly; pick the local model early (Q1).
3. **Latency unmeasured.** Targets (first token 2.5 s, turn 8 s) are untested uncached, and recorded mode hides them. Mitigation: M2-39 and M2-42 record uncached timings; no pass/fail claim on them in M2.
4. **Conformance unverified.** The SRD checks (M2-01, M2-03) may produce engine and catalog rework after the DM layer is built on top. Mitigation: they are first, with no dependencies; M2-02/04 are slotted before the tool executor depends on them.
5. **Forge bottleneck.** 25 of 42 tickets are forge, with a long chain (9 > 10/11 > 20 > 21 > 23 > 24). Mitigation: prism builds on recorded fixtures; M2-14..19 run parallel to the executor work. Slippage here moves everything.

## Open decisions (recommended default in bold)

1. **Q1. Reference endpoint and local model.** Which hosted OpenAI-compatible (or Anthropic) endpoint and key, and which local model, for live runs (D2)? **Default: you supply both before M2-42; CI uses recorded mode only; if absent, criterion 4 is NOT RUN.**
2. **Q2. Live LLM before M3?** **Default: restrict live DM turns to operator-allowlisted accounts until M3 lands moderation.**
3. **Q3. Operator role.** **Default: env allowlist of account emails (no DB role/admin UI).**
4. **Q4. Eval owners and thresholds (spec Q10).** **Default: proof owns the harness, sage owns datasets; spec A10 numbers (rules >= 90%, puppeting < 2%, map contradiction < 2%) as qualification thresholds, with v0 datasets flagged too small to be statistical.**
5. **Q5. Dice fudging (Q8).** **Default: strict honest dice; fail-forward changes stakes only.**
6. **Q6. Adventure #1 theme (Q11).** **Default: quill pitches 3 one-paragraph themes (a ruined waystation with a crypt fits the two existing maps); you pick before M2-30 starts.**
7. **Q7. If the SRD disagrees with our diagonal rule,** switch to the SRD? **Default: yes, as M2-02 (also closes the decisions.md open item).**
8. **Q8. Confirm the push-outs above,** especially magic items and companion NPC to M3, and freeform one-shot to M3. **Default: confirm.**
9. **Q9. SRD 5.2.1 source.** **Default: the official CC-BY PDF fetched by proof; chunked text for `rules_lookup` is committed with the attribution statement.**
10. **Q10. Sentinel's second model family (docs/decisions.md cost note).** **Default: luna or sonnet; astra not used for M2 (M3 gets the one scoped astra review).**

Assumptions: file paths in tickets are expected locations, not verified; `bastion` and `sentinel` scopes follow my reading of the role names. Nothing here was executed against the code beyond reading the repo layout.
