import { useEffect, useRef, useState } from 'react';
import type { RoundSnapshot, ClientSeat } from '@game/schema';
import './round.css';

type Round = RoundSnapshot;
type Submission = Round['submissions'][number];

/** Sends a command over the room socket; returns the wire actionId, or false when offline. */
export type RoomSend = (
  type: string,
  payload: Record<string, unknown>,
) => string | false;

/** Whether a round submission belongs to the given wire actionId (edits can change the current id). */
export function isOwnSubmission(
  item: Submission,
  actionId: string | undefined,
) {
  return (
    actionId !== undefined &&
    (item.actionId === actionId ||
      item.originalActionId === actionId ||
      item.actionIds.includes(actionId as Submission['actionId']))
  );
}

/** Whole seconds left on the round, or null when the round has no deadline. */
export function secondsLeft(round: Round, now: number): number | null {
  if (round.deadlineAt !== null) {
    return Math.max(0, Math.ceil((round.deadlineAt - now) / 1000));
  }
  if (round.remainingMs !== undefined) {
    return Math.ceil(round.remainingMs / 1000);
  }
  return null;
}

function formatTime(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = String(seconds % 60).padStart(2, '0');
  return `${m}:${s}`;
}

function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

const CLOSE_REASON: Record<NonNullable<Round['closeReason']>, string> = {
  'all-submitted': 'Everyone has submitted.',
  timer: 'The time ran out.',
  'resolve-now': 'The host resolved the round.',
};

type Props = {
  round: Round | undefined;
  seats: ClientSeat[];
  /** Wire actionId of this player's latest PlayerAction, from the send that created it. */
  myActionId?: string;
  /** This player's own action text; the public round snapshot omits it. */
  myText?: string;
  connected: boolean;
  send: RoomSend;
  /** Called with the new text once an edit is sent, so the own-action text stays current. */
  onEdited?: (text: string) => void;
  closeAnnouncement?: {
    roundId: string;
    closeReason: NonNullable<Round['closeReason']>;
    summary: string;
  };
};

/** Collect-then-resolve round: who has submitted, time left, and this player's own action. */
export function RoundPanel({
  round,
  seats,
  myActionId,
  myText,
  connected,
  send,
  onEdited,
  closeAnnouncement,
}: Props) {
  const now = useNow(Boolean(round?.deadlineAt));
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setDraft(myText ?? '');
  }, [myText, editing]);
  const [note, setNote] = useState('');
  const [announcement, setAnnouncement] = useState('');
  const announcedRoundClose = useRef<string | undefined>(undefined);

  const open = round?.status === 'open';
  const mine = round?.submissions.find((s) => isOwnSubmission(s, myActionId));
  const queued = round?.queuedSubmissions.find((s) =>
    isOwnSubmission(s, myActionId),
  );
  const ownEntry = mine ?? queued;
  const name = (seatId: string) =>
    seats.find((s) => s.seatId === seatId)?.displayName ?? 'A player';

  const submittedSeats = new Set(round?.submissions.map((s) => s.seatId));
  const eligible = round?.eligibleSeatIds ?? [];
  const submittedCount = eligible.filter((id) => submittedSeats.has(id)).length;
  // A table with one eligible seat is a solo game: there is no one else to wait for.
  const solo = eligible.length === 1;
  const summary = !round
    ? 'No round is open.'
    : solo
      ? submittedCount
        ? 'Your action is in.'
        : 'Your turn.'
      : `${submittedCount} of ${eligible.length} submitted.`;
  const closing =
    round?.closeReason && round.status !== 'open'
      ? CLOSE_REASON[round.closeReason]
      : '';

  // Announce only submission progress and close reasons; the per-second timer stays out of the live region.
  useEffect(() => {
    if (closeAnnouncement) {
      if (announcedRoundClose.current !== closeAnnouncement.roundId) {
        announcedRoundClose.current = closeAnnouncement.roundId;
        setAnnouncement(
          `${closeAnnouncement.summary} ${CLOSE_REASON[closeAnnouncement.closeReason]}`,
        );
      }
      return;
    }
    setAnnouncement(closing ? `${summary} ${closing}` : summary);
  }, [summary, closing, closeAnnouncement]);

  const left = round ? secondsLeft(round, now) : null;

  function saveEdit() {
    if (!ownEntry) return;
    const text = draft.trim();
    if (!text) {
      setNote('Write something before saving, or withdraw your action.');
      return;
    }
    if (!send('EditAction', { editedActionId: ownEntry.actionId, text })) {
      setNote('Not connected, so your edit was not sent. Try again.');
      return;
    }
    onEdited?.(text);
    setEditing(false);
    setNote('Edit sent.');
  }

  function withdraw() {
    if (!ownEntry) return;
    if (!send('WithdrawAction', { withdrawnActionId: ownEntry.actionId })) {
      setNote('Not connected, so your action was not withdrawn. Try again.');
      return;
    }
    setEditing(false);
    setNote('Withdraw sent.');
  }

  return (
    <section aria-labelledby="round-heading" className="round-panel">
      <h2 id="round-heading">Round</h2>
      <p className="round-summary">{summary}</p>
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
      {round && left !== null && (
        <p className="round-timer">
          Time left: <strong>{formatTime(left)}</strong>
          {round.deadlineAt === null && round.remainingMs !== undefined
            ? ' (paused)'
            : ''}
        </p>
      )}
      {round && left !== null && (
        <p className="round-timer-note">
          When the timer reaches 0:00, the round closes and resolves with the
          actions submitted so far.
        </p>
      )}
      {round && left === null && <p className="round-timer">No time limit.</p>}
      {round && !solo && (
        <>
          <h3 id="round-submitted-heading">Submitted</h3>
          <ul aria-labelledby="round-submitted-heading" className="round-seats">
            {eligible.map((seatId) => (
              <li
                key={seatId}
                data-status={
                  submittedSeats.has(seatId) ? 'submitted' : 'waiting'
                }
              >
                {name(seatId)}:{' '}
                {submittedSeats.has(seatId) ? 'submitted' : 'waiting'}
              </li>
            ))}
          </ul>
        </>
      )}
      {ownEntry && (
        <div className="round-own">
          <h3 id="round-own-heading">Your action</h3>
          {queued && !mine && (
            <p className="round-queued">
              Queued for the next round. It will be used when this round closes.
            </p>
          )}
          {!editing && myText && <p>{myText}</p>}
          {open && editing && (
            <>
              <label htmlFor="round-edit-text">Edit your action</label>
              <textarea
                id="round-edit-text"
                value={draft}
                maxLength={4000}
                onChange={(e) => setDraft(e.target.value)}
              />
              <div className="actions">
                <button type="button" onClick={saveEdit} disabled={!connected}>
                  Save edit
                </button>
                <button type="button" onClick={() => setEditing(false)}>
                  Cancel edit
                </button>
              </div>
            </>
          )}
          {open && !editing && (
            <div className="actions">
              <button
                type="button"
                disabled={!connected}
                onClick={() => {
                  setDraft(myText ?? '');
                  setEditing(true);
                }}
              >
                Edit action
              </button>
              <button type="button" disabled={!connected} onClick={withdraw}>
                Withdraw action
              </button>
            </div>
          )}
        </div>
      )}
      <p role="status" aria-live="polite">
        {note}
      </p>
    </section>
  );
}
