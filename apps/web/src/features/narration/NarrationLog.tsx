import { useEffect, useReducer, useRef, useState } from 'react';
import type { ServerMessage } from '@game/schema';
import { RollBreakdown } from '../../RollBreakdown.js';
import {
  initialNarrationLog,
  narrationLogReducer,
  visibleChunks,
  type RollPayload,
} from './logState.js';
import './narration-log.css';

type Props = {
  messages: readonly ServerMessage[];
  combatantNames?: Readonly<Record<string, string>>;
  onRetry?: (actionId: string) => void;
  onResubmit?: (actionId: string) => void;
};

function rollEvent(payload: RollPayload) {
  if (!payload.breakdown) return null;
  return {
    type: 'RollEvent' as const,
    breakdown: payload.breakdown,
    ...(typeof payload.dc === 'number' ? { dc: payload.dc } : {}),
    ...(typeof payload.dcReason === 'string'
      ? { dcReason: payload.dcReason }
      : {}),
  };
}

/** An accessible, replayable view of transient room narration and roll messages. */
export function NarrationLog({
  messages,
  combatantNames = {},
  onRetry,
  onResubmit,
}: Props) {
  const [state, dispatch] = useReducer(
    (current: typeof initialNarrationLog, message: ServerMessage) =>
      narrationLogReducer(current, message),
    initialNarrationLog,
  );
  const [latest, setLatest] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const listRef = useRef<HTMLOListElement>(null);
  const seen = useRef(new Set<string>());
  const announcedTurns = useRef(new Set<string>());
  const announcedRolls = useRef(new Set<string>());
  const announcedCombatEvents = useRef(new Set<string>());

  useEffect(() => {
    for (const message of messages) {
      if (message.type !== 'CombatEvents') continue;
      const events = (message.payload as { events?: unknown }).events;
      if (!Array.isArray(events)) continue;
      events.forEach((raw, index) => {
        if (!raw || typeof raw !== 'object') return;
        const event = raw as Record<string, unknown>;
        const key = `${message.seq}:${index}:${JSON.stringify(event)}`;
        if (announcedCombatEvents.current.has(key)) return;
        announcedCombatEvents.current.add(key);
        const actorId = String(event.entityId ?? event.actorId ?? 'Unknown');
        const name =
          combatantNames[actorId] ??
          (actorId.startsWith('ent_')
            ? actorId.slice(4).replaceAll('-', ' ')
            : 'Player');
        if (
          event.type === 'RollEvent' &&
          event.kind === 'save' &&
          typeof event.dc === 'number' &&
          typeof event.success === 'boolean'
        )
          setAnnouncement(
            `${name}: Constitution save ${String(event.total)} vs DC ${event.dc} - concentration ${event.success ? 'kept' : 'lost'}`,
          );
        else if (event.type === 'ConcentrationDropped')
          setAnnouncement(`${name}: concentration lost`);
      });
    }
  }, [messages, combatantNames]);

  useEffect(() => {
    for (const message of messages) {
      const key = `${message.seq}:${message.type}:${JSON.stringify(message.payload)}`;
      if (seen.current.has(key)) continue;
      seen.current.add(key);
      dispatch(message);
    }
  }, [messages]);

  useEffect(() => {
    for (const entry of state.entries) {
      if (entry.kind !== 'turn') continue;
      if (
        entry.turn.complete &&
        Boolean(entry.turn.narration?.match(/[.!?](?:["')\]]*)$/)) &&
        !announcedTurns.current.has(entry.turn.turnId)
      ) {
        announcedTurns.current.add(entry.turn.turnId);
        setAnnouncement(`Narration: ${entry.turn.narration ?? ''}`);
      }
      entry.turn.rollEvents.forEach((roll, index) => {
        const key = `${entry.turn.turnId}:${index}`;
        if (roll.breakdown && !announcedRolls.current.has(key)) {
          announcedRolls.current.add(key);
          if (entry.turn.complete)
            setAnnouncement(`Roll result: ${roll.breakdown.total}`);
        }
      });
    }
  }, [state]);

  useEffect(() => {
    const node = listRef.current;
    if (!node) return;
    const atBottom =
      node.scrollHeight - node.scrollTop - node.clientHeight < 40;
    setLatest(!atBottom);
    if (atBottom) node.scrollTop = node.scrollHeight;
  }, [state.entries]);

  return (
    <section className="narration-log" aria-label="Narration log">
      <h2>Story</h2>
      {/* A scrollable region must be keyboard focusable (WCAG 2.1.1; axe scrollable-region-focusable),
          and this must stay a plain list: giving it an interactive role would orphan the <li> items. */}
      <ol
        className="narration-log__entries"
        ref={listRef}
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        tabIndex={0}
        aria-label="Story entries; use arrow keys or page keys to scroll"
      >
        {state.entries.map((entry, index) => {
          if (entry.kind === 'pending') {
            return (
              <li
                key={`pending-${entry.actionId}`}
                className="narration-log__pending"
              >
                The DM is thinking…
              </li>
            );
          }
          if (entry.kind === 'error') {
            return (
              <li
                key={`error-${entry.actionId ?? index}-${index}`}
                className="narration-log__error"
              >
                <strong>{entry.code}:</strong> {entry.message}
                {entry.actionId &&
                  onRetry &&
                  entry.code !== 'LIVE_DM_RESTRICTED' && (
                    <button
                      type="button"
                      onClick={() => {
                        onRetry(entry.actionId!);
                        onResubmit?.(entry.actionId!);
                      }}
                    >
                      Retry this action
                    </button>
                  )}
              </li>
            );
          }
          const body = visibleChunks(entry.turn);
          return (
            <li
              key={`turn-${entry.turn.turnId}`}
              className="narration-log__turn"
            >
              <div className="narration-log__rolls">
                {!entry.turn.complete &&
                  entry.turn.rollEvents.map((roll, rollIndex) => {
                    const rendered = rollEvent(roll);
                    return rendered ? (
                      <div key={`${entry.turn.turnId}-roll-${rollIndex}`}>
                        <p className="narration-log__label">Roll result</p>
                        <RollBreakdown event={rendered} />
                      </div>
                    ) : (
                      <p key={`${entry.turn.turnId}-roll-${rollIndex}`}>
                        Roll result: {JSON.stringify(roll)}
                      </p>
                    );
                  })}
              </div>
              {entry.turn.fallback && (
                <p className="narration-log__fallback" role="status">
                  {entry.turn.fallback === 'endpoint-error'
                    ? 'The narration service was unavailable; this is a fallback response.'
                    : entry.turn.fallback === 'budget-exhausted'
                      ? 'The narration limit was reached; this is a fallback response.'
                      : 'Narration could not be generated; this is a fallback response.'}
                </p>
              )}
              <p>
                {body ||
                  (entry.turn.complete
                    ? 'Narration unavailable.'
                    : 'Waiting for narration…')}
              </p>
              {entry.turn.complete && entry.turn.rollEvents.length > 0 && (
                <div className="narration-log__rolls">
                  {entry.turn.rollEvents.map((roll, rollIndex) => {
                    const rendered = rollEvent(roll);
                    return rendered ? (
                      <div key={`${entry.turn.turnId}-roll-${rollIndex}`}>
                        <p className="narration-log__label">Roll result</p>
                        <RollBreakdown event={rendered} />
                      </div>
                    ) : (
                      <p key={`${entry.turn.turnId}-roll-${rollIndex}`}>
                        Roll result: {JSON.stringify(roll)}
                      </p>
                    );
                  })}
                </div>
              )}
            </li>
          );
        })}
        {messages
          .filter((message) => message.type === 'CombatEvents')
          .flatMap((message, messageIndex) => {
            const events = (message.payload as { events?: unknown }).events;
            if (!Array.isArray(events)) return [];
            return events.map((raw, eventIndex) => {
              if (!raw || typeof raw !== 'object') return null;
              const event = raw as Record<string, unknown>;
              const actorId = String(
                event.entityId ?? event.actorId ?? 'Unknown',
              );
              const name =
                combatantNames[actorId] ??
                (actorId.startsWith('ent_')
                  ? actorId.slice(4).replaceAll('-', ' ')
                  : 'Player');
              if (
                event.type === 'RollEvent' &&
                event.kind === 'save' &&
                typeof event.dc === 'number' &&
                typeof event.success === 'boolean'
              )
                return (
                  <li key={`combat-${messageIndex}-${eventIndex}`}>
                    {name}: Constitution save {String(event.total)} vs DC{' '}
                    {event.dc} - concentration {event.success ? 'kept' : 'lost'}
                  </li>
                );
              if (event.type === 'ConcentrationDropped')
                return (
                  <li key={`combat-${messageIndex}-${eventIndex}`}>
                    {name}: concentration lost
                  </li>
                );
              return null;
            });
          })}
      </ol>
      {state.entries.some((entry) => entry.kind === 'pending') && (
        <p className="sr-only" role="status" aria-live="polite">
          The DM is thinking.
        </p>
      )}
      {latest && (
        <button
          type="button"
          className="narration-log__latest"
          onClick={() => {
            const node = listRef.current;
            if (node)
              node.scrollTo({ top: node.scrollHeight, behavior: 'smooth' });
            setLatest(false);
          }}
        >
          Jump to latest
        </button>
      )}
      <div
        className="sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {announcement}
      </div>
    </section>
  );
}
