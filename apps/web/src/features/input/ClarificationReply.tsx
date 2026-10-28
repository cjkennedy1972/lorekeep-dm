import { useState } from 'react';
import './clarification-reply.css';

type Props = {
  actionId: string;
  question: string;
  onReply: (actionId: string, reply: string) => void;
};

/**
 * The DM's question about this seat's own action. It renders inline in the story column rather than in the
 * sticky composer, so it never covers the combat bar. It is a disclosure so the player can collapse it.
 */
export function ClarificationReply({ actionId, question, onReply }: Props) {
  const [reply, setReply] = useState('');
  return (
    <details className="clarification-reply" open>
      <summary>Clarifying question about your action</summary>
      <form
        aria-label="Reply to clarifying question"
        onSubmit={(event) => {
          event.preventDefault();
          const answer = reply.trim();
          if (!answer) return;
          onReply(actionId, answer);
          setReply('');
        }}
      >
        <p>{question}</p>
        <label htmlFor="clarification-reply">Your reply</label>
        <textarea
          id="clarification-reply"
          value={reply}
          onChange={(event) => setReply(event.target.value)}
          maxLength={4000}
          required
        />
        <button type="submit" disabled={!reply.trim()}>
          Reply to this action
        </button>
      </form>
    </details>
  );
}
