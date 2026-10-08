# M2-32 encounter builder verification

The builder's solo default is **moderate**. It applies the SRD per-character moderate XP budget once: levels 1–5 yield 75, 150, 225, 375, and 750 XP. This is derived directly from the SRD instruction to multiply the per-character table value by the number of characters; a solo PC means a multiplier of one. SRD 5.2.1 does not define a special solo adjustment beyond party size, so none is invented. The category’s actual risk for one character remains a human/design decision, since the SRD warns that circumstances and party size change threat.

Citations: SRD 5.2.1, *Playing the Game* → *Gameplay Toolbox* → *Combat Encounters*, “Combat Encounter Difficulty,” XP Budget per Character, and “Spend Your Budget,” p. 202. CR summarizes threat against a group of four and circumstances/party size affect threat: *Rules Glossary*, “Challenge Rating,” p. 178. Monster CR-to-XP values: *Monsters*, “Experience Points by Challenge Rating,” p. 224. The builder only selects monsters from the loaded catalog and respects its CR ≤ 5 scope gate.

The deterministic seeded greedy spend chooses from eligible monsters that fit remaining XP until none fit, honoring the SRD’s no-overspend and spend-as-much-as-possible guidance. This is a deterministic construction strategy, not an SRD mandated selection algorithm.

Adventure #1 content/data is not present in this checkout (its tasks M2-30/M2-31 are pending), so no encounter validation/override audit could be performed here. The subsequent adventure data must include authored override reasons wherever its encounter exceeds its budget.

Verification commands/results are recorded in the PR after execution.
