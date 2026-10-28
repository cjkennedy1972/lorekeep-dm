import {
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { ServerMessage } from '@game/schema';
import { RollBreakdown } from '../../RollBreakdown.js';
import {
  initialNarrationLog,
  narrationLogReducer,
  visibleChunks,
  type RollPayload,
} from './logState.js';
import { rollCardText, summarizeCombatRolls } from './combatRolls.js';
import { NarrationText } from './narrationText.js';
import './narration-log.css';

type Props = {
  messages: readonly ServerMessage[];
  combatantNames?: Readonly<Record<string, string>>;
  /** Whether each combatant is a player character or a monster; monster HP is never shown as a number. */
  combatantKinds?: Readonly<Record<string, 'pc' | 'monster'>>;
  onReport?: (
    messageRef: number,
    category: string,
    reason: string,
  ) => Promise<string | null>;
  /** Shown in place of an empty log, before the first narration arrives. */
  opening?: { title: string; body: ReactNode };
  openingReady?: boolean;
  /** Incremented for every server history restore, including an identical reconnect replay. */
  historyRestoreKey?: number;
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
  combatantKinds = {},
  onReport,
  opening,
  openingReady = true,
  historyRestoreKey = 0,
}: Props) {
  const [state, dispatch] = useReducer(
    (current: typeof initialNarrationLog, message: ServerMessage) =>
      narrationLogReducer(current, message),
    initialNarrationLog,
  );
  // Reader is scrolled away from the newest entry; drives the Jump to latest / New narration chip.
  const [scrolledUp, setScrolledUp] = useState(false);
  // New live narration arrived while the reader was scrolled up.
  const [unseen, setUnseen] = useState(false);
  const followingLatest = useRef(true);
  const [announcement, setAnnouncement] = useState('');
  const [reporting, setReporting] = useState<number | null>(null);
  const [reportMessage, setReportMessage] = useState('');
  const listRef = useRef<HTMLOListElement>(null);
  const previousEntries = useRef(state.entries);
  const reportTriggerRef = useRef<HTMLButtonElement>(null);
  const reportCategoryRef = useRef<HTMLSelectElement>(null);
  const seen = useRef(new Set<string>());
  const announcedTurns = useRef(new Set<string>());
  const announcedRolls = useRef(new Set<string>());
  const announcedCombatEvents = useRef(new Set<string>());
  const announcedCombatBatches = useRef(new Set<number>());
  const nameOfActor = (actorId: string) =>
    combatantNames[actorId] ??
    (actorId.startsWith('ent_')
      ? actorId.slice(4).replaceAll('-', ' ')
      : 'Player');

  const reportAction = (message: ServerMessage) => {
    if (!onReport) return null;
    return (
      <div className="narration-log__report">
        <button
          ref={reportTriggerRef}
          type="button"
          onClick={() => {
            setReportMessage('');
            setReporting(message.seq);
            requestAnimationFrame(() => reportCategoryRef.current?.focus());
          }}
          aria-label="Report this message"
        >
          Report this message
        </button>
        {reporting === message.seq && (
          <form
            aria-label="Report message"
            onSubmit={(event) => {
              event.preventDefault();
              const formData = new FormData(event.currentTarget);
              const category = String(formData.get('category') ?? 'other');
              const reason = String(formData.get('reason') ?? '');
              void onReport(message.seq, category, reason).then((error) => {
                setReportMessage(error ?? 'Report received. Thank you.');
                if (!error) {
                  setReporting(null);
                  requestAnimationFrame(() =>
                    reportTriggerRef.current?.focus(),
                  );
                }
              });
            }}
          >
            <label>
              Category
              <select
                ref={reportCategoryRef}
                name="category"
                defaultValue="other"
              >
                <option value="harassment">Harassment</option>
                <option value="hate">Hate</option>
                <option value="sexual">Sexual content</option>
                <option value="threat_or_self_harm">Threat or self-harm</option>
                <option value="underage">Underage user</option>
                <option value="other">Other</option>
              </select>
            </label>
            <label>
              Optional details
              <textarea name="reason" maxLength={500} />
            </label>
            <button type="submit">Submit report</button>
            <button
              type="button"
              onClick={() => {
                setReporting(null);
                requestAnimationFrame(() => reportTriggerRef.current?.focus());
              }}
            >
              Cancel
            </button>
          </form>
        )}
      </div>
    );
  };

  useEffect(() => {
    for (const message of messages) {
      if (message.type !== 'CombatEvents') continue;
      const events = (message.payload as { events?: unknown }).events;
      if (!Array.isArray(events)) continue;
      // One polite announcement per batch keeps a fight from flooding the live region.
      if (!announcedCombatBatches.current.has(message.seq)) {
        announcedCombatBatches.current.add(message.seq);
        const cards = summarizeCombatRolls(events, (id) => combatantKinds[id]);
        if (cards.length)
          setAnnouncement(
            cards.map((card) => rollCardText(card, nameOfActor)).join(' '),
          );
      }
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
  }, [messages, combatantNames, combatantKinds]);

  useEffect(() => {
    for (const message of messages) {
      if (
        message.type !== 'ActionQueued' &&
        message.type !== 'ActionWithdrawn' &&
        message.type !== 'TurnThinking' &&
        message.type !== 'RollEvent' &&
        message.type !== 'NarrationChunk' &&
        message.type !== 'NarrationCompleted' &&
        message.type !== 'NarrationHistory' &&
        message.type !== 'TurnReverted' &&
        message.type !== 'ToolRejected' &&
        message.type !== 'Error'
      )
        continue;
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
    if (historyRestoreKey === 0) return;
    const node = listRef.current;
    if (!node) return;
    followingLatest.current = true;
    setScrolledUp(false);
    setUnseen(false);
    node.scrollTop = node.scrollHeight;
  }, [historyRestoreKey]);

  // Restored history lands at the bottom with no chip. Live narration follows the bottom while the
  // reader is there; if the reader has scrolled up, it raises the chip instead of moving the text.
  useLayoutEffect(() => {
    const node = listRef.current;
    if (!node) return;
    const priorKeys = new Set(
      previousEntries.current.map((entry) =>
        entry.kind === 'pending'
          ? `pending:${entry.actionId}`
          : `turn:${entry.turn.turnId}`,
      ),
    );
    const added = state.entries.filter(
      (entry) =>
        !priorKeys.has(
          entry.kind === 'pending'
            ? `pending:${entry.actionId}`
            : `turn:${entry.turn.turnId}`,
        ),
    );
    previousEntries.current = state.entries;
    const historyOnly =
      added.length > 0 &&
      added.every((entry) => entry.kind === 'turn' && entry.turn.history);
    if (historyOnly) {
      followingLatest.current = true;
      setScrolledUp(false);
      setUnseen(false);
      node.scrollTop = node.scrollHeight;
      return;
    }
    if (followingLatest.current) {
      node.scrollTop = node.scrollHeight;
    } else if (added.some((entry) => entry.kind === 'turn')) {
      setUnseen(true);
    }
  }, [state.entries]);

  const onListScroll = () => {
    const node = listRef.current;
    if (!node) return;
    const atBottom =
      node.scrollHeight - node.scrollTop - node.clientHeight < 40;
    followingLatest.current = atBottom;
    setScrolledUp(!atBottom);
    if (atBottom) setUnseen(false);
  };

  const jumpToLatest = () => {
    const node = listRef.current;
    followingLatest.current = true;
    setUnseen(false);
    setScrolledUp(false);
    if (node) node.scrollTop = node.scrollHeight;
  };

  return (
    <section className="narration-log" aria-label="Narration log">
      <h2>Story</h2>
      {/* A scrollable region must be keyboard focusable (WCAG 2.1.1; axe scrollable-region-focusable),
          and this must stay a plain list: giving it an interactive role would orphan the <li> items. */}
      <ol
        className="narration-log__entries"
        ref={listRef}
        onScroll={onListScroll}
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        tabIndex={0}
        aria-label="Story entries; use arrow keys or page keys to scroll"
      >
        {messages.map((message) => {
          if (
            message.type !== 'ActionQueued' &&
            message.type !== 'ActionWithdrawn' &&
            message.type !== 'TurnThinking' &&
            message.type !== 'RollEvent' &&
            message.type !== 'NarrationChunk' &&
            message.type !== 'NarrationCompleted' &&
            message.type !== 'TurnReverted' &&
            message.type !== 'ToolRejected'
          )
            return null;
          if (message.type === 'TurnReverted')
            return (
              <li
                className="narration-log__rewind"
                key={`rewind-${message.seq}`}
                role="status"
                aria-live="polite"
              >
                The host rewound the last DM turn. Its narration and game state
                were restored; the next attempt uses a new dice roll.
              </li>
            );
          if (
            message.type === 'NarrationChunk' ||
            message.type === 'NarrationCompleted'
          )
            return null;
          const displayByType: Partial<
            Record<
              'ActionQueued' | 'ActionWithdrawn' | 'TurnThinking' | 'RollEvent',
              string | null
            >
          > = {
            // Queue and thinking status are represented by the replayable reducer entry below.
            ActionQueued: null,
            ActionWithdrawn: 'A queued action was withdrawn.',
            TurnThinking: null,
            RollEvent: 'A roll was made.',
          };
          const content =
            message.type === 'ActionQueued' ||
            message.type === 'ActionWithdrawn' ||
            message.type === 'TurnThinking' ||
            message.type === 'RollEvent'
              ? displayByType[message.type]
              : undefined;
          if (typeof content !== 'string') return null;
          return (
            <li className="narration-log__turn" key={`message-${message.seq}`}>
              <p>{content}</p>
              {reportAction(message)}
            </li>
          );
        })}
        {state.entries.map((entry) => {
          if (entry.kind === 'pending') {
            return (
              <li
                key={`pending-${entry.actionId}`}
                className="narration-log__pending"
              >
                The DM is thinking…
                <span className="thinking-dots" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
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
              {entry.turn.playerText && (
                <p className="narration-log__player-action">
                  You: {entry.turn.playerText}
                </p>
              )}
              {body ? (
                <NarrationText text={body} />
              ) : (
                <p>
                  {entry.turn.complete
                    ? 'Narration unavailable.'
                    : 'Waiting for narration…'}
                </p>
              )}
              {entry.turn.complete &&
                (() => {
                  const completed = messages.find(
                    (message) =>
                      message.type === 'NarrationCompleted' &&
                      String(
                        (message.payload as Record<string, unknown>).turnId ??
                          '',
                      ) === entry.turn.turnId,
                  );
                  return completed ? reportAction(completed) : null;
                })()}
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
            const rollItems = summarizeCombatRolls(
              events,
              (id) => combatantKinds[id],
            ).map((card, cardIndex) => (
              <li
                key={`combat-${messageIndex}-roll-${cardIndex}`}
                className="narration-log__roll"
              >
                {rollCardText(card, nameOfActor)}
              </li>
            ));
            return [
              ...rollItems,
              ...events.map((raw, eventIndex) => {
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
                      {event.dc} - concentration{' '}
                      {event.success ? 'kept' : 'lost'}
                    </li>
                  );
                if (event.type === 'ConcentrationDropped')
                  return (
                    <li key={`combat-${messageIndex}-${eventIndex}`}>
                      {name}: concentration lost
                    </li>
                  );
                return null;
              }),
            ];
          })}
      </ol>
      {opening &&
        openingReady &&
        state.entries.length === 0 &&
        !messages.some((message) => message.type === 'NarrationCompleted') &&
        !messages.some((message) => message.type === 'CombatEvents') && (
          <div className="narration-log__opening">
            <h3>{opening.title}</h3>
            <p>{opening.body}</p>
          </div>
        )}
      {reportMessage && <p role="status">{reportMessage}</p>}
      {state.entries.some((entry) => entry.kind === 'pending') && (
        <p className="sr-only" role="status" aria-live="polite">
          The DM is thinking.
        </p>
      )}
      {scrolledUp && (
        <button
          type="button"
          className="narration-log__latest"
          onClick={jumpToLatest}
        >
          {unseen ? 'New narration' : 'Jump to latest'}
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
