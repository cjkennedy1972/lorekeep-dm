import { useEffect, useMemo, useState } from 'react';
import {
  BattlemapSchema,
  CharacterSchema,
  type CombatState as DisplayCombatState,
  type Battlemap,
  type GridPos,
} from '@game/schema';
import {
  areaCells,
  affectedEntities,
  castSpell,
  apply,
  emptyCombatState,
  rollInitiative,
  startCombat,
  loadAuthoredMap,
  moveAlong,
  path,
  reachable,
  resolveMonsterAttack,
  resolveReaction,
  monsterPolicy,
  type MovementCommandState,
  type PendingReaction,
  type AreaShape,
  cryptScenario,
} from '@game/rules-engine';
import { Canvas2DRenderer } from '../features/map/Canvas2DRenderer.js';
import { Sheet } from '../features/character/Sheet.js';
import { createTokenDrawCommands } from '../features/map/tokens.js';
import { loadCharacterCatalog } from '../features/character/catalog.js';
import cryptData from '../../../../packages/engine/maps/crypt-room.json';
import './sandboxCombat.css';

type Fighter = {
  id: string;
  team: string;
  kind: 'pc' | 'monster';
  pos: GridPos;
  size: number;
  hp: number;
  maxHp: number;
  ac: number;
  speed: number;
  abilities: Record<string, number>;
  attackBonus: number;
  damage: string;
};
type Event = Record<string, unknown> & { type: string };
const loaded = loadAuthoredMap(BattlemapSchema.parse(cryptData));
if (!loaded.ok) throw new Error('Crypt map failed validation');
const map: Battlemap = loaded.map;
const catalog = loadCharacterCatalog();
const scenario = cryptScenario;
const pcTemplate = scenario.pc;
const INITIAL: Fighter[] = [
  structuredClone(pcTemplate),
  ...structuredClone(scenario.goblins),
];
const initiativeState = (() => {
  const combatants = INITIAL.map((fighter) => ({
    id: fighter.id,
    initiativeModifier: Math.floor((fighter.abilities.dex! - 10) / 2),
    speed: fighter.speed,
  }));
  const started = startCombat(emptyCombatState(), combatants);
  if ('error' in started) throw new Error(started.hint);
  const state = started.events.reduce(apply, emptyCombatState());
  const rolled = rollInitiative(state, scenario.seed);
  if ('error' in rolled) throw new Error(rolled.hint);
  return rolled.events.reduce(apply, state);
})();
const characterFor = (pc: Fighter) =>
  CharacterSchema.parse({
    id: '00000000-0000-4000-8000-000000000041',
    name: 'Aria',
    speciesId: 'species:human',
    classId: 'class:wizard',
    backgroundId: 'background:acolyte',
    level: 1,
    abilities: pc.abilities,
    proficiencies: { skills: [], saves: ['int', 'wis'], tools: [] },
    equipment: [],
    spellsKnown: [scenario.spellId],
    spellsPrepared: [scenario.spellId],
    slots: { '1': { max: 2, used: 0 } },
    hp: { current: pc.hp, max: pc.maxHp, temp: 0 },
    conditions: [],
  });
const moveState = (fighters: Fighter[]): MovementCommandState => ({
  map,
  entities: fighters.map((e) => ({
    ...e,
    reaction: e.kind === 'monster',
    opportunityAttack:
      e.kind === 'monster'
        ? {
            seed: 611,
            attackId: 'opportunity',
            attackBonus: e.attackBonus,
            damage: e.damage,
            damageType: 'slashing',
            targetAc: 12,
          }
        : undefined,
  })),
  resources: Object.fromEntries(
    fighters.map((e) => [
      e.id,
      { movementRemaining: e.speed, reaction: e.kind === 'monster' },
    ]),
  ),
  hp: Object.fromEntries(fighters.map((e) => [e.id, e.hp])),
  reactions: Object.fromEntries(
    fighters.map((e) => [e.id, e.kind === 'monster']),
  ),
});
const spellMap = (fighters: Fighter[], pc: Fighter) => ({
  map,
  caster: { pos: pc.pos, size: 1 },
  entities: fighters.map((e) => ({
    id: e.id,
    pos: e.pos,
    size: e.size,
    team: e.team,
  })),
  targets: fighters.map((e) => ({
    id: e.id,
    hp: e.hp,
    maxHp: e.maxHp,
    ac: e.ac,
    abilities: e.abilities,
  })),
  direction: scenario.areaDirection,
});
function rollText(events: Event[]) {
  const ev = [...events].reverse().find((e) => e.type === 'RollEvent') as
    | {
        breakdown?: {
          expression?: string;
          total?: number;
          dice?: { value: number; kept: boolean }[];
        };
      }
    | undefined;
  return ev?.breakdown
    ? `${ev.breakdown.expression}: ${ev.breakdown.dice?.map((d) => (d.kept ? d.value : `${d.value} dropped`)).join(', ')} = ${ev.breakdown.total}`
    : 'No roll yet';
}
export function SandboxCombat() {
  const [fighters, setFighters] = useState<Fighter[]>(() =>
    structuredClone(INITIAL),
  );
  const [stage, setStage] = useState<'ready' | 'reaction' | 'area' | 'ended'>(
    'ready',
  );
  const [events, setEvents] = useState<Event[]>([{ type: 'CombatStarted' }]);
  const [message, setMessage] = useState(
    'Use arrow keys to preview a legal destination; Enter moves.',
  );
  const [cursor, setCursor] = useState<GridPos>(pcTemplate.pos);
  const [goal, setGoal] = useState<GridPos | null>(null);
  const [pendingReaction, setPendingReaction] =
    useState<PendingReaction | null>(null);
  const [areaPreview, setAreaPreview] = useState(false);
  const commands = useMemo(() => new Canvas2DRenderer().render(map), []);
  const pc = fighters[0]!;
  const moveEngineState = moveState(fighters);
  const reachableCells = reachable(moveEngineState, 'pc-aria');
  const pathResult = goal ? path(moveEngineState, 'pc-aria', goal) : null;
  const areaTemplate = catalog.get('spell', scenario.spellId)?.template;
  const cells = areaTemplate
    ? areaCells(
        map,
        {
          shape: areaTemplate.shape as AreaShape,
          size: areaTemplate.size,
          width: areaTemplate.width,
        },
        scenario.areaAnchor,
        scenario.areaDirection,
      )
    : [];
  const affected = areaTemplate
    ? affectedEntities(
        cells,
        {
          map,
          entities: fighters.map((e) => ({
            id: e.id,
            pos: e.pos,
            size: e.size,
          })),
        },
        scenario.areaAnchor,
      )
        .filter((e) => e.id !== 'pc-aria')
        .map((e) => fighters.find((f) => f.id === e.id)?.id ?? e.id)
    : [];
  useEffect(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('#crypt-map');
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    new Canvas2DRenderer().draw(ctx, map, { cellSize: 28 });
    const snapshot: DisplayCombatState = {
      round: 1,
      turnIndex: 0,
      initiative: initiativeState.initiative.map(({ entityId, total }) => ({
        entityId,
        total,
      })),
      resources: {},
      entities: fighters.map((f) => ({
        id: f.id,
        kind: f.kind === 'pc' ? 'character' : 'monster',
        pos: f.pos,
        size: f.size,
        hp: f.hp,
      })),
    };
    const presentation = Object.fromEntries(
      fighters.map((f) => [
        f.id,
        {
          name: f.kind === 'pc' ? 'Aria' : f.id,
          team: f.team,
          maxHp: f.maxHp,
        },
      ]),
    );
    for (const token of createTokenDrawCommands(snapshot, presentation)) {
      ctx.fillStyle = token.team === 'pc' ? '#155eef' : '#a52a2a';
      ctx.beginPath();
      ctx.arc((token.x + 0.5) * 28, (token.y + 0.5) * 28, 9, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'white';
      ctx.font = 'bold 11px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(
        token.teamMarker.letter,
        (token.x + 0.5) * 28,
        (token.y + 0.5) * 28 + 4,
      );
      ctx.font = '10px sans-serif';
      ctx.fillText(
        token.hpLabel,
        (token.x + 0.5) * 28,
        (token.y + 0.5) * 28 + 20,
      );
    }
    ctx.strokeStyle = '#f0b429';
    ctx.lineWidth = 3;
    ctx.strokeRect(cursor.x * 28 + 2, cursor.y * 28 + 2, 24, 24);
  }, [commands, cursor, fighters]);
  const append = (items: readonly unknown[]) =>
    setEvents((old) => [
      ...old,
      ...items.map((e) => ({ ...(e as object) }) as Event),
    ]);
  const actMonsters = (starting: Fighter[], seed: number) => {
    let next = starting.map((f) => ({ ...f, pos: { ...f.pos } })),
      rng = seed;
    const log: Event[] = [];
    const fled = new Set<string>();
    for (
      let round = 0;
      round < 5 &&
      next.some((f) => f.kind === 'monster' && f.hp > 0 && !fled.has(f.id));
      round++
    ) {
      let acted = false;
      for (const monster of next.filter(
        (f) => f.kind === 'monster' && f.hp > 0,
      )) {
        const policy = monsterPolicy({
          map,
          entities: next,
          monsterId: monster.id,
          fleeing: true,
        });
        log.push({
          type: 'MonsterPolicy',
          monsterId: monster.id,
          decision: policy.kind,
        });
        if (policy.kind === 'attack') {
          const target = next.find((f) => f.id === policy.targetId)!;
          const result = resolveMonsterAttack(monster, target, rng++);
          if ('events' in result) {
            log.push(...(result.events as Event[]));
            for (const ev of result.events as Event[])
              if (ev.type === 'HpChanged') target.hp = Number(ev.to);
            acted = true;
          }
        } else if (policy.kind === 'approach' || policy.kind === 'flee') {
          const movement = moveAlong(
            moveState(next),
            monster.id,
            policy.path,
            policy.kind === 'flee' ? 'forced' : 'normal',
          );
          if (!('error' in movement)) {
            log.push(...(movement.events as Event[]));
            next = next.map((f) => ({
              ...f,
              pos: movement.state.entities.find((e) => e.id === f.id)!.pos,
              hp: movement.state.hp?.[f.id] ?? f.hp,
            }));
            if (policy.kind === 'flee') fled.add(monster.id);
            acted = true;
          }
        }
      }
      if (!acted) break;
    }
    if (
      next
        .filter((f) => f.kind === 'monster')
        .every((f) => f.hp <= 0 || fled.has(f.id))
    ) {
      log.push({
        type: 'CombatEnded',
        reason: next.every((f) => f.kind !== 'monster' || f.hp <= 0)
          ? 'all-goblins-down'
          : 'all-goblins-fled',
      });
    }
    return { next, log };
  };
  const move = () => {
    if (!goal || !pathResult || !('path' in pathResult)) {
      setMessage(
        pathResult && 'hint' in pathResult
          ? pathResult.hint
          : 'Choose a reachable square.',
      );
      return;
    }
    const result = moveAlong(moveState(fighters), 'pc-aria', pathResult.path);
    if ('error' in result) {
      setMessage(result.hint);
      return;
    }
    const next = fighters.map((f) => ({
      ...f,
      pos: result.state.entities.find((e) => e.id === f.id)!.pos,
      hp: result.state.hp?.[f.id] ?? f.hp,
    }));
    append(result.events);
    const pending = result.pending[0];
    if (pending) {
      setPendingReaction(pending);
      setStage('reaction');
      setMessage(
        `Opportunity attack from ${pending.hostileId}. Press Y to accept or N to decline.`,
      );
    } else {
      setFighters(next);
      setStage('area');
      setMessage('Move resolved. Choose the Burning Hands target area.');
    }
  };
  const answerReaction = (choice: 'take' | 'decline') => {
    if (!pendingReaction) return;
    const result = resolveReaction(
      {
        ...moveState(fighters),
        pendingReactions: { [pendingReaction.reactionId]: pendingReaction },
      },
      pendingReaction.reactionId,
      choice,
    );
    if ('error' in result) {
      setMessage(result.hint);
      return;
    }
    append(result.events);
    setFighters(
      fighters.map((f) => ({
        ...f,
        pos: result.state.entities.find((e) => e.id === f.id)!.pos,
        hp: result.state.hp?.[f.id] ?? f.hp,
      })),
    );
    const nextReaction = result.pending[0];
    if (nextReaction) {
      setPendingReaction(nextReaction);
      setMessage(
        `Opportunity attack from ${nextReaction.hostileId}. Press Y to accept or N to decline.`,
      );
      return;
    }
    setPendingReaction(null);
    setStage('area');
    setMessage(
      'Reaction resolved. Preview the Burning Hands area, then press Enter to cast.',
    );
  };
  const cast = () => {
    const result = castSpell({
      caster: characterFor(pc),
      target: { kind: 'anchor', pos: scenario.areaAnchor },
      spellId: scenario.spellId,
      slotLevel: 1,
      seed: scenario.seed,
      catalog,
      map: spellMap(fighters, pc),
    });
    if ('error' in result) {
      setMessage(result.hint);
      return;
    }
    append(result.events);
    let next = fighters.map((f) => ({
      ...f,
      hp: result.state.hp[f.id] ?? f.hp,
    }));
    const monsters = actMonsters(next, result.rng);
    next = monsters.next;
    append(monsters.log);
    setFighters(next);
    if (monsters.log.some((e) => e.type === 'CombatEnded')) {
      setStage('ended');
      setMessage(
        'CombatEnded — every goblin is down or fled under the scripted policy.',
      );
    } else
      setMessage(
        `Monster policy acted. ${next.filter((f) => f.kind === 'monster' && f.hp > 0).length} goblins remain; encounter is still active.`,
      );
  };
  const keyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (stage === 'ended') return;
    if (stage === 'reaction') {
      if (event.key.toLowerCase() === 'y') answerReaction('take');
      if (event.key.toLowerCase() === 'n' || event.key === 'Escape')
        answerReaction('decline');
      return;
    }
    if (stage === 'area') {
      if (event.key.toLowerCase() === 'a') {
        setAreaPreview(true);
        setMessage(
          `Burning Hands engine preview: ${affected.map((id) => fighters.find((f) => f.id === id)?.id ?? id).join(', ') || 'no creatures'} affected.`,
        );
      } else if (event.key === 'Enter' && areaPreview) cast();
      return;
    }
    if (event.key.startsWith('Arrow')) {
      event.preventDefault();
      const delta = {
        ArrowUp: [0, -1],
        ArrowDown: [0, 1],
        ArrowLeft: [-1, 0],
        ArrowRight: [1, 0],
      }[event.key] as number[];
      const dest = { x: cursor.x + delta![0]!, y: cursor.y + delta![1]! };
      setCursor(dest);
      setGoal(dest);
      const result = path(moveEngineState, 'pc-aria', dest);
      if ('path' in result)
        setMessage(
          `Path preview: ${result.path.map((p) => `${p.x + 1},${p.y + 1}`).join(' → ')}; cost ${result.cost} ft.`,
        );
      else setMessage(`Illegal path: ${result.reason} — ${result.hint}`);
    } else if (event.key === 'Enter' && goal) move();
  };

  return (
    // This focusable application surface provides a keyboard map controller.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <div
      className="sandbox"
      onKeyDown={keyDown}
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
      tabIndex={0}
      role="application"
      aria-label="Solo combat sandbox"
    >
      <header>
        <h1>Solo combat sandbox</h1>
        <p>Crypt encounter · deterministic local rules · no network or LLM</p>
      </header>
      <div className="sandbox-grid">
        <section aria-labelledby="map-title">
          <h2 id="map-title">Crypt battle map</h2>
          <canvas
            id="crypt-map"
            width={map.w * 28}
            height={map.h * 28}
            aria-label="Crypt map with Aria and goblins"
            role="img"
          />
          <p>
            Keyboard: Arrow keys preview · Enter moves/casts · Y accepts
            opportunity attack · N declines · A previews area.
          </p>
          <div aria-live="polite" role="status">
            {message}
          </div>
          {stage === 'reaction' && (
            <div role="dialog" aria-label="Opportunity attack">
              <p>
                Pending engine reaction: opportunity attack by{' '}
                {pendingReaction?.hostileId}
              </p>
              <button onClick={() => answerReaction('take')}>Accept (Y)</button>
              <button onClick={() => answerReaction('decline')}>
                Decline (N)
              </button>
            </div>
          )}
          {stage === 'ended' && (
            <strong data-testid="combat-ended">CombatEnded</strong>
          )}
        </section>
        <aside>
          <Sheet character={characterFor(pc)} />
          <section aria-label="Initiative tracker">
            <h2>Initiative</h2>
            <ol>
              {initiativeState.initiative.map((entry, index) => {
                const fighter = fighters.find((f) => f.id === entry.entityId)!;
                return (
                  <li
                    key={fighter.id}
                    aria-current={index === 0 ? 'true' : undefined}
                  >
                    {fighter.kind === 'pc' ? 'Aria' : fighter.id}: {entry.total}
                    {fighter.kind === 'pc'
                      ? ` · ${fighter.hp}/${fighter.maxHp} HP`
                      : ` · ${fighter.hp > fighter.maxHp / 2 ? 'healthy' : 'bloodied'}`}
                  </li>
                );
              })}
            </ol>
          </section>
          <section aria-label="Dice breakdown">
            <h2>Dice breakdown</h2>
            <p>{rollText(events)}</p>
          </section>
          <section aria-label="Combat log">
            <h2>Combat log</h2>
            <ol>
              {events.map((entry, i) => (
                <li key={`${entry.type}-${i}`}>{entry.type}</li>
              ))}
            </ol>
          </section>
          {goal && (
            <p>
              Reachable destinations:{' '}
              {Array.isArray(reachableCells) ? reachableCells.length : 0}
            </p>
          )}
          {goal && pathResult && 'cost' in pathResult && (
            <p data-testid="path-cost">{pathResult.cost} ft</p>
          )}
          {areaPreview && (
            <ul aria-label="Affected creatures">
              {affected.map((id) => (
                <li key={id}>{id}</li>
              ))}
            </ul>
          )}
        </aside>
      </div>
    </div>
  );
}
