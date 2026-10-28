import { useEffect, useRef, useState } from 'react';
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
  /** This player's last action failed; the text is back in the box. */
  failure?: { message: string; canRetry: boolean } | null;
  onRetry?: () => void;
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
  failure = null,
  onRetry,
}: Props) {
  const [text, setText] = useState(initialText);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // The parent sets the text when a failed action is restored, an edit starts, or Retry clears it.
  useEffect(() => {
    setText(initialText);
  }, [initialText]);
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
      {failure && (
        <div className="action-input__failure" role="alert">
          <p>{failure.message}</p>
          {failure.canRetry && onRetry && (
            <button
              type="button"
              onClick={() => {
                onRetry();
                // Retry removes this button when the failure clears; keep keyboard focus in the action box.
                textareaRef.current?.focus();
              }}
            >
              Retry this action
            </button>
          )}
        </div>
      )}
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
          ref={textareaRef}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            onDraftChange?.(event.target.value);
          }}
          maxLength={4000}
          required
        />
        {text.length >= 3500 && (
          <span className="action-input__count" aria-live="off">
            {text.length} / 4000
          </span>
        )}
        <button type="submit" disabled={!text.trim() || pending}>
          Send action
        </button>
      </form>
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
    </section>
  );
}
