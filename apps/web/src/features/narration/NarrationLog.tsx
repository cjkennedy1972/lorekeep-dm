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
export function NarrationLog({ messages, onRetry, onResubmit }: Props) {
  const [state, dispatch] = useReducer(
    (current: typeof initialNarrationLog, message: ServerMessage) =>
      narrationLogReducer(current, message),
    initialNarrationLog,
  );
  const [latest, setLatest] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const seen = useRef(new Set<string>());
  const announcedTurns = useRef(new Set<string>());
  const announcedRolls = useRef(new Set<string>());

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
        !announcedTurns.current.has(entry.turn.turnId)
      ) {
        announcedTurns.current.add(entry.turn.turnId);
        setAnnouncement(`Narration: ${entry.turn.narration ?? ''}`);
      }
      entry.turn.rollEvents.forEach((roll, index) => {
        const key = `${entry.turn.turnId}:${index}`;
        if (roll.breakdown && !announcedRolls.current.has(key)) {
          announcedRolls.current.add(key);
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
      <div
        className="narration-log__entries"
        ref={listRef}
        tabIndex={0}
        role="listbox"
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
                {entry.actionId && onRetry && (
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
              <p>
                {body ||
                  (entry.turn.complete
                    ? 'Narration unavailable.'
                    : 'Waiting for narration…')}
              </p>
            </li>
          );
        })}
      </div>
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
