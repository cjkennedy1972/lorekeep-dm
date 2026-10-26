# M4-9a six-PC vs goblins balance triage

Card: `90bddedb-6949-4198-a4ae-8f2a850b209c`
Source claim: `docs/plan/evidence/m4-9a-six-client-combat-sim.md` reports that a six-PC level-1 party vs two goblins is defeated in 4–8 rounds.
Base: `origin/main` 74e8a4f. Branch `proof/balance-triage`.

## Conclusion

**(a) Test-script behaviour.** The defeat comes from the sim driver, not from level-1 balance. The shipped spotlight loop in `apps/server/test/db/sim-combat.test.ts` sends only `end-turn` for PC seats, so the PCs never attack. Two goblins then win by attrition.

Secondary finding, separate from the defeat: the monster attack path records goblin hits as `slashing`, while the catalog says `piercing` (see "Engine finding" below). This does not cause the defeat, but it will affect any resistance or immunity check against goblin hits.

The "4–8 rounds" figure did not reproduce. Idle-PC runs ended at rounds 15, 20 and 23. I did not find the source of the 4–8 figure.

## Method

- Fresh worktree `~/.openclaw/workspace/wt-proof-balance` off `origin/main` 74e8a4f. The dirty main checkout `lorekeep-dm` was not touched.
- Postgres 16 in Docker (`proof-balance-pg`, 127.0.0.1:55440). Migrations applied with `pnpm run migrate:up`.
- Scratch driver `zz-balance-dump.test.ts` (kept outside the repo, not committed). It reuses `partyCombat` and the spotlight loop, runs one configuration per seed, and dumps every event to JSON.
- Configs:
  - **A-idle**: the spotlight loop as shipped (PCs `end-turn` only). Seeds 7, 8, 9.
  - **B-attack-spawn**: PCs move toward the nearest living foe and attack. Goblins at their engine spawn cells. Seeds 7, 8.
  - **C-attack-fixture**: as B, but goblins placed by `startPartyCombat`'s `placed()`. Seed 7.

## Results

| Config | Seed | Outcome | Last round | PC attacks (hits) | Goblin attacks (hits) | Dmg to PCs |
|---|---|---|---|---|---|---|
| A-idle (spotlight) | 7 | party-defeated | 23 | 0 | 26 (15) | 74 |
| A-idle | 8 | party-defeated | 15 | 0 | 25 (16) | 76 |
| A-idle | 9 | party-defeated | 20 | 0 | 23 (17) | 78 |
| B-attack-spawn | 7 | party-victory | 3 | 6 (3) | 1 (1) | 5 |
| B-attack-spawn | 8 | party-victory | 3 | 8 (5) | 1 (1) | 6 |
| C-attack-fixture | 7 | enemies-fled | 2 | 5 (2) | 0 | 0 |

Notes:
- Idle runs: goblin damage per hit averages about 4.6–4.9, consistent with `1d4+2` (average 4.5) and hits at about 65%, which is the expected rate against AC 12 with +4.
- B seed 7, round 2: PC `ent_seat_87a7…` moved one square and attacked GOB1 (roll total 16 vs AC 12, hit), dealing 7 and killing it. Round 3 finished GOB2.
- C seed 7: GOB1 died on the first PC attack. GOB2 dropped to 1/7 HP (14%, under the 25% flee threshold), fled, and the engine ended combat with `enemies-fled`.

## Driver bug found and fixed (scratch only)

The first B and C runs logged 5–6 `That attack is not currently available.` rejections. Those results were superseded.

- Cause: the tracker sends `hpState` for non-party entities and omits `hp`. The driver merged tracker entities into its local map, so dead goblins kept `hp: 7` and were still chosen as targets.
- The engine rejection is correct: `apps/server/src/room/combat.ts:415` rejects attacks when `target.hp <= 0` or `target.fled`.
- Fix: the driver filters foes on `hpState !== 'down' && !fled`. Reruns show no rejections, only the expected final `Combat is over.`.

This is a driver artefact. The old results were removed (superseded dumps renamed `*.v1-driver-bug.json`, not committed).

## Engine finding (not the cause of the defeat)

`packages/engine/src/scripted/policy.ts` hard-codes the monster attack:
- lines 114 and 118: `attackId: 'scimitar'`, `damageType: 'slashing'`.

`packages/engine/catalog/monsters-low.json`, entry `monster:goblin-minion` (around line 3637), defines the attack as **Dagger, 1d4+2, piercing**.

Dump evidence: `A-idle-seed8` `HpChanged` events on a PC report `damageType: "slashing"` for goblin hits.

Effect: a PC with piercing resistance or immunity would be scored wrong against goblin hits. Monsters with a different damage type would be affected the same way.

Suggested reproduction: a unit test that resolves `resolveMonsterAttack` for `monster:goblin-minion` and asserts `damageType === 'piercing'` and `attackId === 'dagger'`. I did not commit a failing test; this is a suggestion for the implementer.

## Harness issues to note (not product bugs)

- `apps/server/test/sim/combat.ts` `placed()` can put a goblin on a PC seat cell (for example goblin 1 at (8,2), the same cell as a PC seat). Config C shows the overlap does not break the engine, but the placement is invalid.
- PC AC is hard-coded to 12 and attack to `+4 1d6+2` in `combatFixtures.ts`, regardless of each character sheet. The balance numbers above therefore reflect the fixture, not the real six-PC build.
- The card cites SRD 5.1 goblin stats (AC 15, scimitar). The catalog uses the SRD 5.2.1 minion (AC 12, dagger). Results depend on which one is intended.
- No death saves: PCs at 0 HP go straight to `unconscious` (deferred to M1-14).

## Uncertainties

- I did not reproduce the "4–8 rounds" figure in any config. I do not know which build or setup produced it.
- The reaction path (`not-your-turn` for a monster-bound controller, listed as Blocked in the evidence doc) was not isolated in these runs. Config A uses `combatActors` for goblin 1, but I did not confirm the prompt behaviour.
- Sample size is 3 idle seeds and 2–3 attack seeds. Enough for direction, not a distribution.
- Balance for a real six-PC build is not established here. The fixture hard-codes PC AC and attack.

## Recommended next actions

1. **Forge (test fix):** change the spotlight loop in `sim-combat.test.ts` so PC seats attack, or assert the loss explicitly and label it as a non-balance test.
2. **Forge (engine fix):** take monster attack id and damage type from the monster's `attacks` in `policy.ts` instead of hard-coding them, with the failing test above.
3. **Forge (fixture):** make `placed()` avoid occupied cells, and build PC attacks from each character sheet.
4. Re-run the balance check with real PC sheets before drawing a level-1 balance conclusion.

## Reproduce

```
cd apps/server
DATABASE_URL=postgres://lorekeep:lorekeep@127.0.0.1:55440/lorekeep \
  pnpm exec vitest run test/db/zz-balance-dump.test.ts --testTimeout=400000
```

The scratch driver is not committed. A copy is kept outside the repo at `/tmp/balance/scratch/zz-balance-dump.test.ts` on the analysis machine. Copy it into `apps/server/test/db/` to rerun it, and delete it before any commit.
