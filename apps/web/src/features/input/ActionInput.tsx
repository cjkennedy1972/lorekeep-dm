import { useEffect, useState } from 'react';
import './action-input.css';

export const QUICK_ACTIONS = [
  { label: 'Look', text: 'I look around.' },
  { label: 'Talk', text: 'I try to talk to them.' },
  { label: 'Search', text: 'I search the area.' },
  { label: 'Move', text: 'I move closer.' },
  { label: 'Use item', text: 'I use an item.' },
  { label: 'Cast', text: 'I cast a spell.' },
] as const;

type Props = {
  onSubmit: (text: string) => void;
  pending?: boolean;
  pendingText?: string;
  pendingSince?: number;
  onEditPending?: () => void;
  initialText?: string;
  onDraftChange?: (text: string) => void;
  clarification?: { actionId: string; question: string } | null;
  onReply?: (actionId: string, reply: string) => void;
};

/** Keyboard-first free-text and quick-action input; pending work stays editable. */
export function ActionInput({
  onSubmit,
  pending = false,
  pendingText,
  pendingSince,
  onEditPending,
  initialText = '',
  onDraftChange,
  clarification = null,
  onReply,
}: Props) {
  const [text, setText] = useState(initialText);
  const [reply, setReply] = useState('');
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  useEffect(() => {
    if (!pending || pendingSince === undefined) {
      setElapsedSeconds(0);
      return;
    }
    const update = () =>
      setElapsedSeconds(Math.floor((Date.now() - pendingSince) / 1000));
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [pending, pendingSince]);
  const submit = (value: string) => {
    const action = value.trim();
    if (!action || pending) return;
    onSubmit(action);
    setText('');
    onDraftChange?.('');
  };
  return (
    <section className="action-input" aria-label="Action input">
      {pending && (
        <div className="action-input__pending" role="status" aria-live="polite">
          <span>
            {pendingText ? `Queued: ${pendingText}` : 'The DM is thinking…'}
          </span>
          {pendingSince !== undefined && (
            <span aria-live="off">Waiting {elapsedSeconds}s</span>
          )}
          {onEditPending && (
            <button type="button" onClick={onEditPending}>
              Edit before resolution
            </button>
          )}
        </div>
      )}
      {clarification && (
        <form
          aria-label="Reply to clarifying question"
          onSubmit={(event) => {
            event.preventDefault();
            const answer = reply.trim();
            if (!answer || !onReply) return;
            onReply(clarification.actionId, answer);
            setReply('');
          }}
        >
          <p>{clarification.question}</p>
          <label htmlFor="clarification-reply">Your reply</label>
          <textarea
            id="clarification-reply"
            value={reply}
            onChange={(event) => setReply(event.target.value)}
            maxLength={4000}
            required
          />
          <button type="submit" disabled={!reply.trim() || !onReply}>
            Reply to this action
          </button>
        </form>
      )}
      <div className="action-input__quick" aria-label="Quick actions">
        {QUICK_ACTIONS.map((action) => (
          <button
            type="button"
            key={action.label}
            disabled={pending}
            onClick={() => submit(action.text)}
          >
            {action.label}
          </button>
        ))}
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit(text);
        }}
        aria-label="Player action"
      >
        <label htmlFor="player-action">Your action</label>
        <textarea
          id="player-action"
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            onDraftChange?.(event.target.value);
          }}
          maxLength={4000}
          required
        />
        <button type="submit" disabled={!text.trim() || pending}>
          Send action
        </button>
      </form>
    </section>
  );
}
