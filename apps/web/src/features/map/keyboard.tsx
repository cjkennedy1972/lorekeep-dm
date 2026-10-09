import {
  moveAlong,
  reachable,
  resolveReaction,
  type MovementCommandState,
  type MovementEvent,
} from '@game/rules-engine';
import type { GridPos } from '@game/schema';
import { useEffect, useMemo, useState } from 'react';
import { gameStore, type GameState } from '../../state/gameStore.js';

type Props = {
  store?: typeof gameStore;
  entityTeams?: Record<string, string>;
  onMovementEvents?: (events: readonly MovementEvent[]) => void;
  onReactionResolved?: (result: ReturnType<typeof resolveReaction>) => void;
  onMove?: (destination: GridPos) => void;
  reactionPrompt?: {
    reactionId: string;
    entityId: string;
    moverId: string;
    trigger: string;
  } | null;
  onReactionChoice?: (reactionId: string, choice: 'take' | 'decline') => void;
};

const same = (a: GridPos, b: GridPos) => a.x === b.x && a.y === b.y;

/** Accessible keyboard controller for map selection, movement preview, and reactions. */
export function MapKeyboard({
  store = gameStore,
  entityTeams = {},
  onMovementEvents,
  onReactionResolved,
  onMove,
  reactionPrompt,
  onReactionChoice,
}: Props) {
  const [state, setState] = useState<GameState>(() => store.getState());
  const [cursor, setCursor] = useState<GridPos | null>(null);
  const [moving, setMoving] = useState(false);
  const [message, setMessage] = useState('');
  const [dialogRef, setDialogRef] = useState<HTMLDivElement | null>(null);
  const [localReaction, setReaction] = useState<{
    reactionId: string;
    moverId: string;
    hostileId: string;
    remainingPath: GridPos[];
    mode: 'normal' | 'disengage' | 'forced';
  } | null>(null);
  const reaction = reactionPrompt
    ? {
        reactionId: reactionPrompt.reactionId,
        moverId: reactionPrompt.moverId,
        hostileId: reactionPrompt.entityId,
        remainingPath: [],
        mode: 'normal' as const,
      }
    : localReaction;

  useEffect(() => store.subscribe(() => setState(store.getState())), [store]);
  const entities = state.combat.initiative
    .map((entry) =>
      state.combat.combatants.find((item) => item.id === entry.entityId),
    )
    .filter((item): item is NonNullable<typeof item> => Boolean(item));
  const selectedId =
    state.tracker?.initiative[0]?.entityId ??
    state.combat.activeEntityId ??
    entities[0]?.id ??
    null;
  const selected = state.combat.combatants.find(
    (item) => item.id === selectedId,
  );
  const placed = state.mapEntities;
  const mover = placed.find((item) => item.id === selectedId);
  const start = mover?.pos ?? null;
  const point = cursor ?? start;

  const movementState = useMemo<MovementCommandState | null>(() => {
    if (!state.battlemap) return null;
    const speed =
      state.combat.resources[selectedId ?? '']?.movementRemaining ??
      selected?.speed ??
      0;
    return {
      map: state.battlemap,
      entities: placed.map((item) => ({
        ...item,
        team: entityTeams[item.id] ?? item.team ?? item.kind,
        kind: item.kind === 'character' ? 'pc' : 'monster',
      })),
      resources: Object.fromEntries(
        placed.map((item) => [
          item.id,
          {
            movementLeft:
              state.combat.resources[item.id]?.movementRemaining ?? speed,
            reaction: state.combat.resources[item.id]?.reaction,
          },
        ]),
      ),
    };
  }, [state, placed, selectedId, selected, entityTeams]);

  const preview = useMemo(() => {
    if (!movementState || !selectedId || !point) return null;
    const cells = reachable(movementState, selectedId);
    if (!Array.isArray(cells))
      return {
        error: cells.error,
        hint: cells.hint,
        path: [] as GridPos[],
        cost: 0,
      };
    const found = cells.find((item) => same(item.cell, point));
    if (!found)
      return {
        error: 'Illegal destination.',
        hint: 'Choose a reachable cell within your movement.',
        path: [] as GridPos[],
        cost: 0,
      };
    return { path: found.path, cost: found.cost, error: null, hint: '' };
  }, [movementState, selectedId, point]);

  const announce = (text: string) => {
    setMessage(text);
    store.setAnnouncement(text);
  };
  const selectEntity = (id: string) => {
    const entity = placed.find((item) => item.id === id);
    if (entity) {
      setCursor({ ...entity.pos });
      setMoving(false);
      announce(`${id} selected at ${entity.pos.x + 1}, ${entity.pos.y + 1}.`);
    }
  };
  const cycle = (direction: number) => {
    if (!entities.length) return;
    const index = entities.findIndex((item) => item.id === selectedId);
    const next =
      entities[(index + direction + entities.length) % entities.length]!;
    const entity = placed.find((item) => item.id === next.id);
    if (entity) {
      setCursor({ ...entity.pos });
      setMoving(false);
      announce(
        `${next.id} selected at ${entity.pos.x + 1}, ${entity.pos.y + 1}.`,
      );
    }
  };
  const nearestEnemy = () => {
    if (!mover) return;
    const enemy = placed
      .filter(
        (item) =>
          item.id !== mover.id &&
          (entityTeams[item.id] ?? item.team ?? item.kind) !==
            (entityTeams[mover.id] ?? mover.team ?? mover.kind),
      )
      .sort(
        (a, b) =>
          Math.hypot(a.pos.x - mover.pos.x, a.pos.y - mover.pos.y) -
          Math.hypot(b.pos.x - mover.pos.x, b.pos.y - mover.pos.y),
      )[0];
    if (enemy) selectEntity(enemy.id);
  };
  const confirm = () => {
    if (!movementState || !selectedId || !preview) return;
    if (preview.error) {
      announce(preview.hint || preview.error);
      return;
    }
    if (preview.path.length < 2) {
      setMoving(false);
      announce('Movement cancelled.');
      return;
    }
    if (onMove) {
      onMove(preview.path.at(-1)!);
      setMoving(false);
      return;
    }
    const result = moveAlong(movementState, selectedId, preview.path);
    if ('error' in result) {
      announce(
        result.reason
          ? `${result.error} ${result.hint} (${result.reason})`
          : `${result.error} ${result.hint}`,
      );
      return;
    }
    onMovementEvents?.(result.events);
    store.setMapEntities(
      result.state.entities.map((item) => ({
        ...item,
        kind: placed.find((entry) => entry.id === item.id)?.kind ?? 'monster',
        hp: item.hp,
        team: item.team,
      })),
    );
    for (const event of result.events)
      if (event.type === 'MovementSpent') store.applyEvent(event);
    const first = result.pending[0];
    setReaction(first ?? null);
    if (first)
      announce(
        `Opportunity attack from ${first.hostileId}. Choose accept or decline.`,
      );
    else
      announce(
        `Moved to ${preview.path.at(-1)!.x + 1}, ${preview.path.at(-1)!.y + 1}; ${preview.cost} feet.`,
      );
    setMoving(false);
  };
  useEffect(() => {
    if (reaction)
      dialogRef?.querySelector<HTMLButtonElement>('button')?.focus();
  }, [reaction, dialogRef]);
  const resolve = (choice: 'take' | 'decline') => {
    if (!reaction) return;
    if (reactionPrompt) {
      onReactionChoice?.(reaction.reactionId, choice);
      return;
    }
    if (!movementState) return;
    const withPending = {
      ...movementState,
      pendingReactions: { [reaction.reactionId]: reaction },
    };
    const result = resolveReaction(withPending, reaction.reactionId, choice);
    onReactionResolved?.(result);
    if ('error' in result) {
      announce(`${result.error} ${result.hint}`);
      return;
    }
    store.setMapEntities(
      result.state.entities.map((item) => ({
        ...item,
        kind: placed.find((entry) => entry.id === item.id)?.kind ?? 'monster',
        hp: item.hp,
        team: item.team,
      })),
    );
    for (const event of result.events)
      if (event.type === 'MovementSpent') store.applyEvent(event);
    const next = result.pending[0];
    setReaction(next ?? null);
    announce(
      next
        ? `Opportunity attack from ${next.hostileId}.`
        : `Reaction ${choice === 'take' ? 'accepted' : 'declined'}.`,
    );
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (reaction) return;
    if (
      ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)
    ) {
      event.preventDefault();
      if (!point || !state.battlemap) return;
      const delta = {
        ArrowUp: [0, -1],
        ArrowDown: [0, 1],
        ArrowLeft: [-1, 0],
        ArrowRight: [1, 0],
      }[event.key]!;
      const next = {
        x: Math.max(0, Math.min(state.battlemap.w - 1, point.x + delta[0]!)),
        y: Math.max(0, Math.min(state.battlemap.h - 1, point.y + delta[1]!)),
      };
      setCursor(next);
      if (moving) {
        const check = reachable(movementState!, selectedId!);
        const found = Array.isArray(check)
          ? check.find((item) => same(item.cell, next))
          : null;
        announce(
          found
            ? `Path cost ${found.cost} feet.`
            : 'Illegal destination. Choose a reachable cell within your movement.',
        );
      } else announce(`Cursor ${next.x + 1}, ${next.y + 1}.`);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (!moving) {
        setMoving(true);
        setCursor(start);
        announce(
          'Move mode. Use arrow keys to choose a destination; Enter confirms.',
        );
      } else confirm();
      return;
    }
    if (event.key.toLowerCase() === 'y') {
      event.preventDefault();
      selectEntity(selectedId ?? '');
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      setMoving(false);
      setCursor(start);
      announce('Movement cancelled.');
      return;
    }
    if (event.key === '[') {
      event.preventDefault();
      cycle(-1);
      return;
    }
    if (event.key === ']') {
      event.preventDefault();
      cycle(1);
      return;
    }
    if (event.key.toLowerCase() === 'e') {
      event.preventDefault();
      nearestEnemy();
      return;
    }
    if (event.key.toLowerCase() === 'm') {
      event.preventDefault();
      if (mover) {
        setCursor({ ...mover.pos });
        setMoving(true);
        announce('Move mode.');
      }
      return;
    }
  };

  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <div
      role="application"
      aria-label="Battle map"
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
      tabIndex={0}
      onKeyDown={onKeyDown}
      data-cursor-x={point?.x}
      data-cursor-y={point?.y}
      data-moving={moving}
    >
      <p>
        Selected: {selectedId ?? 'none'}
        {point ? `; cursor ${point.x + 1}, ${point.y + 1}` : ''}
      </p>
      {moving && (
        <p>Move preview: {preview?.error ?? `${preview?.cost ?? 0} feet`}</p>
      )}
      <div aria-live="polite" aria-atomic="true" role="status">
        {message}
      </div>
      {reaction && (
        // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
        <div
          ref={setDialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="map-reaction-title"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              resolve('decline');
            }
          }}
        >
          <h2 id="map-reaction-title">Opportunity attack</h2>
          <p>
            {reaction.hostileId} can make an opportunity attack against{' '}
            {reaction.moverId}.
          </p>
          <button onClick={() => resolve('take')}>Accept</button>
          <button onClick={() => resolve('decline')}>Decline</button>
        </div>
      )}
    </div>
  );
}
