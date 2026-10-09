import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useAuth } from '../auth.js';
import { useRef } from 'react';
import type { Battlemap, ServerMessage } from '@game/schema';
import {
  BattlemapSchema,
  CharacterSchema,
  EngineEventSchema,
} from '@game/schema';
import { Canvas2DRenderer } from '../features/map/Canvas2DRenderer.js';
import { createTokenDrawCommands } from '../features/map/tokens.js';
import { MapKeyboard } from '../features/map/keyboard.js';
import { TokenTable } from '../features/map/TokenTable.js';
import { Describe } from '../features/map/Describe.js';
import { NarrationLog } from '../features/narration/NarrationLog.js';
import { Sheet } from '../features/character/Sheet.js';
import { ConnectionStatus } from '../room/ConnectionStatus.js';
import { useRoom } from '../room/useRoom.js';
import { http } from '../api.js';
import { gameStore } from '../state/store.js';

const renderer = new Canvas2DRenderer();
type Tracker = NonNullable<ReturnType<typeof gameStore.getState>['tracker']>;
type Entity = {
  id: string;
  kind: 'character' | 'monster' | 'npc';
  team: string;
  pos: { x: number; y: number };
  size: number;
  hp: number;
  hpState?: string;
  fled?: boolean;
};
type Reaction = {
  reactionId: string;
  entityId: string;
  moverId: string;
  trigger: string;
  timeoutMs: number;
};
/** The server's tracker lists the active combatant first; persisted state keeps a fixed order. */
const startAtActive = <T extends { entityId: string }>(
  initiative: T[],
  activeEntityId: unknown,
): T[] => {
  const at = initiative.findIndex((item) => item.entityId === activeEntityId);
  return at > 0
    ? [...initiative.slice(at), ...initiative.slice(0, at)]
    : initiative;
};
/** Tracker entities are sparse (no size; enemy HP is qualitative): keep what the persisted state already told us. */
const mergeEntities = (previous: Entity[], next: Entity[]): Entity[] =>
  next.map((entity) => {
    const old = previous.find((item) => item.id === entity.id);
    return { ...old, ...entity, size: entity.size ?? old?.size ?? 1 };
  });
const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {};

export function Game() {
  const { id = '' } = useParams();
  const { account } = useAuth();
  const live = useRoom({
    baseUrl: http.base,
    fetchImpl: (...args) => http.fetch(...args),
    WebSocketImpl: http.WebSocket,
    onMessage: (message) => {
      const isRepeat = messagesRef.current.some(
        (entry) =>
          entry.seq === message.seq &&
          entry.type === message.type &&
          JSON.stringify(entry.payload) === JSON.stringify(message.payload),
      );
      if (!isRepeat) {
        messagesRef.current = [...messagesRef.current, message];
        setMessages(messagesRef.current);
      }
      if (message.type === 'CombatTracker') {
        // Combat can start after we joined, so the join-time state has no map yet.
        if (!mapRef.current && !resyncAsked.current) {
          resyncAsked.current = true;
          live.send('Resync');
        }
        const payload = asRecord(message.payload);
        setTracker(payload as unknown as Tracker);
        if (Array.isArray(payload.entities))
          setEntities((current) =>
            mergeEntities(current, payload.entities as Entity[]),
          );
      }
      if (message.type === 'CombatEvents') {
        const events = asRecord(message.payload).events;
        if (Array.isArray(events))
          for (const raw of events) {
            const parsed = EngineEventSchema.safeParse(raw);
            if (!parsed.success) continue;
            const event = parsed.data;
            if (event.type === 'EntityMoved') {
              const last = event.path.at(-1)!;
              setEntities((current) =>
                current.map((entity) =>
                  entity.id === event.entityId
                    ? { ...entity, pos: last }
                    : entity,
                ),
              );
            }
            if (
              event.type === 'HpChanged' ||
              event.type === 'ConditionApplied' ||
              event.type === 'ConditionRemoved' ||
              event.type === 'SlotSpent'
            ) {
              setEntities((current) =>
                current.map((entity) =>
                  entity.id === event.entityId && event.type === 'HpChanged'
                    ? { ...entity, hp: event.hp }
                    : entity,
                ),
              );
              gameStore.applyEvent(event);
            }
          }
      }
      if (message.type === 'ReactionPrompt')
        setReaction(message.payload as Reaction);
      if (message.type === 'CombatOptions')
        setOptions(asRecord(message.payload));
      if (message.type === 'CombatEnded') {
        setReaction(null);
        setTracker((current) =>
          current
            ? {
                ...current,
                ended: asRecord(message.payload) as { outcome: string },
              }
            : current,
        );
      }
      if (message.type === 'Error')
        setError(
          String(asRecord(message.payload).message ?? 'The command failed.'),
        );
    },
  });
  const [messages, setMessages] = useState<ServerMessage[]>([]);
  const messagesRef = useRef<ServerMessage[]>([]);
  const [tracker, setTracker] = useState<Tracker | null>(null);
  const [entities, setEntities] = useState<Entity[]>([]);
  const [map, setMap] = useState<Battlemap | null>(null);
  const mapRef = useRef<Battlemap | null>(null);
  mapRef.current = map;
  const resyncAsked = useRef(false);
  const [reaction, setReaction] = useState<Reaction | null>(null);
  const [reactionRemainingMs, setReactionRemainingMs] = useState(0);
  useEffect(() => {
    if (!reaction) {
      setReactionRemainingMs(0);
      return;
    }
    const deadline = Date.now() + reaction.timeoutMs;
    const update = () =>
      setReactionRemainingMs(Math.max(0, deadline - Date.now()));
    update();
    const timer = window.setInterval(update, 100);
    return () => window.clearInterval(timer);
  }, [reaction?.reactionId, reaction?.timeoutMs]);
  const [options, setOptions] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState('');
  const [actionText, setActionText] = useState('');
  const room = live.room;
  useEffect(() => {
    if (!room?.gameState) return;
    const gs = asRecord(room.gameState);
    const combat = asRecord(gs.combatRoom);
    if (Array.isArray(combat.entities))
      setEntities(combat.entities as Entity[]);
    if (combat.map) {
      const parsed = BattlemapSchema.safeParse(combat.map);
      if (parsed.success) setMap(parsed.data);
    }
    const accountCharacter = account
      ? asRecord(gs.characters)[account.id]
      : undefined;
    if (accountCharacter) {
      const parsed = CharacterSchema.safeParse(accountCharacter);
      if (parsed.success) gameStore.setCharacter(parsed.data);
    }
    if (combat.combat) {
      const c = asRecord(combat.combat);
      const t = {
        round: Number(c.round ?? 1),
        activeEntityId:
          typeof c.activeEntityId === 'string' ? c.activeEntityId : null,
        initiative: Array.isArray(c.initiative)
          ? startAtActive(
              c.initiative as Tracker['initiative'],
              c.activeEntityId,
            )
          : [],
        resources: asRecord(c.resources) as Tracker['resources'],
      };
      setTracker(t);
      gameStore.setTracker(t);
      gameStore.setCombatState({
        round: t.round,
        turnIndex: 0,
        initiative: t.initiative.map((item, index) => ({
          entityId: item.entityId,
          total: item.total,
          dexterity: 0,
          tieOrder: index,
        })),
        activeEntityId: t.initiative[0]?.entityId ?? null,
        resources: Object.fromEntries(
          Object.entries(t.resources).map(([entityId, value]) => [
            entityId,
            {
              action: value.action,
              bonusAction: value.bonusAction,
              reaction: value.reaction,
              movementRemaining: value.movementRemaining,
            },
          ]),
        ),
        combatants: Array.isArray(combat.entities)
          ? (combat.entities as Entity[]).map((item) => ({
              id: item.id,
              initiativeModifier: 0,
              speed: 30,
            }))
          : [],
      });
    }
  }, [room, account]);

  const send = (command: Record<string, unknown>) =>
    live.send('CombatCommand', command);
  const submitAction = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = actionText.trim();
    if (!text) return;
    live.send('PlayerAction', { text });
    setMessages((current) => [
      ...current,
      {
        seq: Date.now(),
        type: 'ActionQueued',
        payload: { actionId: `local-${Date.now()}` },
      } as ServerMessage,
    ]);
    setActionText('');
  };
  const tokenCommands = useMemo(
    () =>
      tracker
        ? createTokenDrawCommands(
            {
              round: tracker.round,
              turnIndex: 0,
              initiative: tracker.initiative,
              resources: Object.fromEntries(
                Object.entries(tracker.resources).map(([key, value]) => [
                  key,
                  {
                    action: value.action,
                    bonusAction: value.bonusAction,
                    reaction: value.reaction,
                    movementLeft: value.movementRemaining,
                  },
                ]),
              ),
              entities: entities.map(
                ({ id: entityId, kind, pos, size, hp }) => ({
                  id: entityId,
                  kind,
                  pos,
                  size,
                  hp,
                }),
              ),
            },
            Object.fromEntries(
              entities.map((item) => [
                item.id,
                { team: item.team, name: item.id, maxHp: Math.max(item.hp, 1) },
              ]),
            ),
          )
        : [],
    [tracker, entities],
  );
  const trackerFirst = tracker?.initiative[0]?.entityId ?? null;
  const active = trackerFirst;
  const describedTracker = tracker
    ? { ...tracker, activeEntityId: trackerFirst }
    : null;
  useEffect(() => {
    if (tracker)
      gameStore.setCombatState({
        ...gameStore.getState().combat,
        initiative: tracker.initiative.map((item, index) => ({
          ...item,
          dexterity: 0,
          tieOrder: index,
        })),
        activeEntityId: tracker.initiative[0]?.entityId ?? null,
        round: tracker.round,
        resources: Object.fromEntries(
          Object.entries(tracker.resources).map(([entityId, value]) => [
            entityId,
            {
              action: value.action,
              bonusAction: value.bonusAction,
              reaction: value.reaction,
              movementRemaining: value.movementRemaining,
            },
          ]),
        ),
      });
  }, [tracker]);
  useEffect(() => {
    gameStore.setTracker(describedTracker);
    gameStore.setBattlemap(map);
    gameStore.setMapEntities(entities.map((item) => ({ ...item, speed: 30 })));
  }, [describedTracker, map, entities]);
  const canvasCommands = map ? renderer.render(map, { cellSize: 32 }) : [];
  const canvasSize = map
    ? { width: map.w * 32, height: map.h * 32 }
    : { width: 0, height: 0 };

  if (!room)
    return (
      <section>
        <h1>Game</h1>
        <ConnectionStatus status={live.status} />
        <p role="status">Waiting for room state…</p>
      </section>
    );
  const activeEntity = entities.find((item) => item.id === active);
  const actions = Array.isArray(asRecord(options).actions)
    ? (asRecord(options).actions as unknown[])
    : [];
  return (
    <main className="game-screen">
      <header>
        <h1>{id ? 'Game' : 'Encounter'}</h1>
        <ConnectionStatus status={live.status} />
        <Link to={`/rooms/${id}`}>Back to lobby</Link>
      </header>
      <p role="status" aria-live="polite">
        {error}
      </p>
      <form onSubmit={submitAction} aria-label="Player action">
        <label htmlFor="player-action">Your action</label>
        <textarea
          id="player-action"
          value={actionText}
          onChange={(event) => setActionText(event.target.value)}
          maxLength={4000}
          required
        />
        <button type="submit">Send action</button>
      </form>
      {!tracker && (
        <p>
          Combat has not started. Describe the encounter above to begin combat.
        </p>
      )}
      {tracker && (
        <section aria-labelledby="tracker-heading">
          <h2 id="tracker-heading">Round {tracker.round}</h2>
          <ol aria-label="Initiative tracker">
            {tracker.initiative.map((item, index) => (
              <li
                key={`${item.entityId}-${index}`}
                aria-current={
                  item.entityId === trackerFirst ? 'step' : undefined
                }
              >
                {item.entityId}
                {item.entityId === trackerFirst ? ' (active)' : ''}
              </li>
            ))}
          </ol>
        </section>
      )}
      {map && (
        <section aria-label="Battle map" className="game-map">
          <h2>Battle map</h2>
          <MapKeyboard
            store={gameStore}
            onMove={(destination) => send({ command: 'move', destination })}
            reactionPrompt={reaction}
            onReactionChoice={(reactionId, choice) =>
              send({ command: 'reaction', reactionId, choice })
            }
          />
          <div
            className="game-map__canvas"
            aria-label={`Battle map ${map.w} columns by ${map.h} rows; tokens listed below`}
          >
            <canvas
              aria-hidden="true"
              width={canvasSize.width}
              height={canvasSize.height}
              ref={(canvas) => {
                if (canvas)
                  renderer.draw(canvas.getContext('2d')!, map, {
                    cellSize: 32,
                  });
              }}
              data-command-count={canvasCommands.length}
            />
            <ul aria-label="Combat tokens">
              {tokenCommands.map((token) => (
                <li
                  key={token.entityId}
                  data-active={token.entityId === trackerFirst}
                  data-x={token.x}
                  data-y={token.y}
                >
                  {token.teamMarker.shape} {token.name} — {token.hpLabel}
                  {token.active ? ', active' : ''}
                </li>
              ))}
            </ul>
          </div>
          <TokenTable store={gameStore} viewerId={active ?? undefined} />
          <Describe store={gameStore} viewerId={active ?? undefined} />
        </section>
      )}
      {tracker && (
        <section aria-label="Combat commands">
          <h2>Combat actions</h2>
          <button type="button" onClick={() => send({ command: 'options' })}>
            Refresh combat options
          </button>
          {actions.map((value, index) => {
            const item = asRecord(value);
            if (item.kind === 'attack')
              return (
                <button
                  key={String(item.optionId ?? index)}
                  type="button"
                  onClick={() =>
                    send({
                      command: 'attack',
                      targetId: String(item.targetId),
                      attackId: String(item.attackId),
                    })
                  }
                >
                  Attack {String(item.targetId)}
                </button>
              );
            if (item.kind === 'spell')
              return (
                <button
                  key={String(item.optionId ?? index)}
                  type="button"
                  onClick={() =>
                    send({
                      command: 'cast',
                      spellId: String(item.spellId),
                      slotLevel: 1,
                      target: { kind: 'entity', ref: String(item.targetId) },
                    })
                  }
                >
                  Cast {String(item.spellId)} on {String(item.targetId)}
                </button>
              );
            if (item.kind === 'move')
              return (
                <button
                  key={String(item.optionId ?? index)}
                  type="button"
                  onClick={() =>
                    send({ command: 'move', destination: item.destination })
                  }
                >
                  Move to {String(asRecord(item.destination).x)},{' '}
                  {String(asRecord(item.destination).y)} ({String(item.cost)}{' '}
                  feet)
                </button>
              );
            return null;
          })}
          <button type="button" onClick={() => send({ command: 'end-turn' })}>
            End turn
          </button>
          {reaction && (
            <p role="status">
              {reaction.entityId} reaction: {reaction.trigger}. Resolve within{' '}
              {Math.ceil(reactionRemainingMs / 1000)} seconds.
            </p>
          )}
        </section>
      )}
      {tracker?.ended && (
        <p role="status">CombatEnded: {tracker.ended.outcome}</p>
      )}
      {activeEntity && <p>Active combatant: {activeEntity.id}</p>}
      <NarrationLog messages={messages} />
      <Sheet store={gameStore} />
    </main>
  );
}
