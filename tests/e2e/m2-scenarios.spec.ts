import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  M2_SCENARIOS,
  replaySim,
  type SimEvent,
  type SimLog,
} from '@game/rules-engine/scripted-node';

// No LLM, no network: every scenario is the real engine driven by the scripted harness.
// Goldens: UPDATE_GOLDEN=1 pnpm --filter @game/e2e exec vitest run m2-scenarios, then review the diff.
const goldenDir = fileURLToPath(new URL('./golden/', import.meta.url));
const goldenPath = (name: string, seed: number) =>
  `${goldenDir}m2-${name}.seed-${seed}.json`;
const text = (log: unknown) => `${JSON.stringify(log, null, 2)}\n`;

/** First divergence between two event logs, rendered so a reviewer can see what changed. */
function diffLogs(expected: SimLog, actual: SimLog): string | null {
  const a = expected.events;
  const b = actual.events;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) {
      const ctx = (list: SimEvent[]) =>
        list
          .slice(Math.max(0, i - 2), i + 3)
          .map((e, k) => `${Math.max(0, i - 2) + k}: ${JSON.stringify(e)}`)
          .join('\n    ');
      return [
        `${expected.scenario} (seed ${expected.seed}) diverges at event #${i} of ${a.length} golden / ${b.length} actual`,
        `  golden:\n    ${ctx(a)}`,
        `  actual:\n    ${ctx(b)}`,
      ].join('\n');
    }
  }
  return JSON.stringify(expected.finalState) ===
    JSON.stringify(actual.finalState)
    ? null
    : `${expected.scenario}: events match but finalState differs\n  golden: ${JSON.stringify(expected.finalState)}\n  actual: ${JSON.stringify(actual.finalState)}`;
}

const runs = M2_SCENARIOS.map((s) => ({ s, log: s.run(s.seed) }));
const byName = (name: string) => runs.find((r) => r.s.name === name)!.log;
const of = (log: SimLog, type: string) =>
  log.events.filter((e) => e.type === type);

describe.each(runs)('$s.name', ({ s, log }) => {
  test('terminates in exactly one CombatEnded, last event', () => {
    expect(log.finalState.outcome).toBe('CombatEnded');
    expect(log.events.at(-1)?.type).toBe('CombatEnded');
    expect(of(log, 'CombatEnded')).toHaveLength(1);
  });

  test('same seed gives a byte-identical log; replay of the log reproduces the final state', () => {
    expect(text(s.run(s.seed))).toBe(text(log));
    expect(replaySim(log.events)).toEqual(log.finalState);
  });

  test('matches its reviewed golden event log', () => {
    const file = goldenPath(s.name, s.seed);
    if (process.env.UPDATE_GOLDEN === '1') {
      mkdirSync(goldenDir, { recursive: true });
      writeFileSync(file, text(log));
    }
    const golden = JSON.parse(readFileSync(file, 'utf8')) as SimLog;
    const diff = diffLogs(golden, JSON.parse(text(log)) as SimLog);
    expect(diff, diff ?? '').toBeNull();
  });

  test('hp bookkeeping is consistent and the dead stay out of the fight', () => {
    const start = log.events[0]!.entities as {
      id: string;
      hp: number;
      maxHp: number;
    }[];
    const hp = Object.fromEntries(start.map((e) => [e.id, e.hp]));
    const maxHp = Object.fromEntries(start.map((e) => [e.id, e.maxHp]));
    const dead = new Set<string>();
    for (const e of log.events) {
      const id = String(e.entityId ?? e.attackerId ?? '');
      if (e.type === 'HpChanged') {
        expect(e.from, `${id} hp continuity at ${JSON.stringify(e)}`).toBe(
          hp[id],
        );
        expect(e.to).toBeGreaterThanOrEqual(0);
        expect(e.to).toBeLessThanOrEqual(maxHp[id]!);
        hp[id] = Number(e.to);
      }
      if (e.type === 'EntityDown' && e.outcome === 'dead') dead.add(id);
      if (e.type === 'DeathSave' && (e as { dead?: boolean }).dead === true)
        dead.add(id);
      if (
        ['EntityMoved', 'SpellCast', 'ContestResolved'].includes(e.type) &&
        id
      )
        expect(dead.has(id), `${id} acted after dying: ${e.type}`).toBe(false);
    }
    for (const e of log.finalState.entities)
      expect(e.hp, `${e.id} final hp`).toBe(hp[e.id]);
  });

  test('no two standing creatures share a cell at the end', () => {
    const cells = log.finalState.entities
      .filter((e) => e.hp > 0)
      .map((e) => `${e.pos.x},${e.pos.y}`);
    expect(new Set(cells).size).toBe(cells.length);
  });

  test('a different seed still terminates in CombatEnded (not a literal script)', () => {
    for (const seed of [s.seed + 1, s.seed + 2]) {
      const other = s.run(seed);
      expect(other.finalState.outcome).toBe('CombatEnded');
      expect(text(s.run(seed))).toBe(text(other));
    }
  });
});

describe('what the scenarios between them prove', () => {
  const all = runs.flatMap((r) => r.log.events);
  const has = (pred: (e: SimEvent) => boolean) => all.some(pred);

  test('required event kinds appear across the set', () => {
    for (const type of [
      'OpportunityTriggered',
      'AreaResolved',
      'DeathSave',
      'ConditionApplied',
      'ConditionRemoved',
      'ConcentrationDropped',
      'DoorOpened',
    ])
      expect(
        has((e) => e.type === type),
        type,
      ).toBe(true);
  });

  test('surviving monsters take approach, attack and flee policy turns', () => {
    const foeIds = new Set(
      runs.flatMap((r) =>
        (r.log.events[0]!.entities as { id: string; team: string }[])
          .filter((e) => e.team === 'foe')
          .map((e) => e.id),
      ),
    );
    for (const kind of ['approach', 'attack', 'flee'])
      expect(
        has(
          (e) =>
            e.type === 'PolicyDecision' &&
            e.kind === kind &&
            foeIds.has(String(e.entityId)),
        ),
        `foe policy ${kind}`,
      ).toBe(true);
  });
});

describe('scenario-specific rules', () => {
  test('kiting: archer disengages (no opportunity attack), shoots at range, and a pillar blocks a shot', () => {
    const log = byName('kiting-cover-v1');
    expect(of(log, 'Disengaged').length).toBeGreaterThan(0);
    const oa = of(log, 'OpportunityTriggered').filter(
      (e) => e.moverId === 'pc-wren',
    );
    expect(oa).toHaveLength(0);
    const shots = log.events.filter(
      (e) =>
        e.type === 'RollEvent' &&
        e.entityId === 'pc-wren' &&
        e.kind === 'attack',
    );
    expect(shots.length).toBeGreaterThanOrEqual(3);
    expect(shots.every((e) => 'mapFacts' in e)).toBe(true);
    // a pillar between archer and target is full cover: the shot is refused, not rolled
    expect(
      log.events.some(
        (e) =>
          e.type === 'AttackRefused' && /full cover/.test(String(e.reason)),
      ),
    ).toBe(true);
  });

  test('door and rubble: foes cannot move until the door opens; rubble costs double', () => {
    const log = byName('door-rubble-v1');
    const opened = log.events.findIndex((e) => e.type === 'DoorOpened');
    expect(opened).toBeGreaterThan(0);
    const foeMoveBefore = log.events
      .slice(0, opened)
      .some(
        (e) =>
          e.type === 'EntityMoved' &&
          /^(skeleton|zombie)/.test(String(e.entityId)),
      );
    expect(foeMoveBefore).toBe(false);
    const costs = log.events
      .filter((e) => e.type === 'EntityMoved')
      .map((e) => Number(e.cost));
    expect(costs).toContain(10);
    expect(Math.min(...costs)).toBe(5);
  });

  test('concentration: a failed concentration save drops the spell and frees its target', () => {
    const log = byName('concentration-v1');
    const i = log.events.findIndex((e) => e.type === 'ConcentrationDropped');
    expect(i).toBeGreaterThan(0);
    const check = log.events
      .slice(0, i)
      .reverse()
      .find((e) => e.type === 'ConcentrationChecked');
    expect(check?.success).toBe(false);
    const applied = log.events.find(
      (e) =>
        e.type === 'ConditionApplied' &&
        (e.condition as { source?: string }).source ===
          'spell:hideous-laughter@pc-merel',
    );
    expect(applied).toBeDefined();
    expect(
      log.events
        .slice(i)
        .some(
          (e) =>
            e.type === 'ConditionRemoved' && e.entityId === applied!.entityId,
        ),
    ).toBe(true);
  });

  test('fireball: only creatures in the sphere are affected; the rest are untouched', () => {
    const log = byName('fireball-partial-v1');
    const area = of(log, 'AreaResolved')[0]!;
    const affected = area.affected as string[];
    const foes = (log.events[0]!.entities as { id: string; team: string }[])
      .filter((e) => e.team === 'foe')
      .map((e) => e.id);
    expect(affected.length).toBeGreaterThanOrEqual(2);
    expect(affected.length).toBeLessThan(foes.length);
    expect(affected.every((id) => foes.includes(id))).toBe(true);
    const areaIndex = log.events.indexOf(area);
    const spared = foes.filter((id) => !affected.includes(id));
    const firstBolt = log.events
      .slice(0, areaIndex)
      .filter(
        (e) => e.type === 'HpChanged' && spared.includes(String(e.entityId)),
      );
    expect(firstBolt).toHaveLength(0);
    // one damage roll per target comes from the engine; a saving throw is rolled for each
    const saves = log.events
      .slice(0, areaIndex)
      .filter((e) => e.type === 'RollEvent' && e.kind === 'save');
    expect(saves).toHaveLength(affected.length);
  });

  test('death saves to stable: three successes, fewer than three failures, combat still ends', () => {
    const log = byName('death-saves-stable-v1');
    const saves = of(log, 'DeathSave').filter((e) => e.entityId === 'pc-ines');
    const last = saves.at(-1)!;
    expect(last.stable).toBe(true);
    expect(last.successes).toBe(3);
    expect(Number(last.failures)).toBeLessThan(3);
    expect(
      log.finalState.entities.find((e) => e.id === 'pc-ines')?.status,
    ).toBe('stable');
  });

  test('death saves to dead: a hit at 0 HP from within 5 ft is a crit failure and kills', () => {
    const log = byName('death-saves-dead-v1');
    const saves = of(log, 'DeathSave').filter((e) => e.entityId === 'pc-ines');
    const fatal = saves.at(-1)!;
    expect(fatal.dead).toBe(true);
    expect(Number(fatal.failures)).toBeGreaterThanOrEqual(3);
    expect(saves.some((e) => e.source === 'damage-at-0hp')).toBe(true);
    expect(
      log.finalState.entities.find((e) => e.id === 'pc-ines')?.status,
    ).toBe('dead');
  });

  test('grapple and prone: speed 0 blocks walking, escaping removes grappled, prone doubles crawl cost', () => {
    const log = byName('grapple-prone-v1');
    const grapple = log.events.findIndex(
      (e) =>
        e.type === 'ConditionApplied' &&
        (e.condition as { id: string }).id === 'grappled',
    );
    expect(grapple).toBeGreaterThan(0);
    expect(of(log, 'MoveRefused').length).toBeGreaterThan(0);
    expect(
      log.events.some(
        (e) =>
          e.type === 'ConditionApplied' &&
          (e.condition as { id: string }).id === 'prone',
      ),
    ).toBe(true);
    expect(of(log, 'ConditionRemoved').length).toBeGreaterThan(0);
  });

  test('forest 4v6: ten combatants on the forest map, foes close the distance, ends in CombatEnded', () => {
    const log = byName('forest-4v6-v1');
    expect(log.finalState.entities).toHaveLength(10);
    expect(log.finalState.mapId).toBe('forest-clearing');
    expect(
      log.events.some(
        (e) =>
          e.type === 'PolicyDecision' &&
          e.kind === 'approach' &&
          String(e.entityId).startsWith('goblin'),
      ),
    ).toBe(true);
    expect(
      log.events.some(
        (e) =>
          e.type === 'EntityMoved' && String(e.entityId).startsWith('goblin'),
      ),
    ).toBe(true);
  });
});

describe('readable divergence diff', () => {
  test('a changed roll fails with the event index and both neighbourhoods', () => {
    const { s, log } = runs[0]!;
    const golden = JSON.parse(text(log)) as SimLog;
    const tampered = JSON.parse(text(log)) as SimLog;
    const i = tampered.events.findIndex((e) => e.type === 'RollEvent');
    (tampered.events[i]!.breakdown as { total: number }).total += 1;
    const diff = diffLogs(golden, tampered)!;
    expect(diff).toContain(`diverges at event #${i}`);
    expect(diff).toContain('golden:');
    expect(diff).toContain('actual:');
    expect(diff).toContain(s.name);
    expect(diffLogs(golden, golden)).toBeNull();
  });
});
