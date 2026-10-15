import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { ServerMessage } from '@game/schema';
import { NarrationLog } from '../src/features/narration/NarrationLog.js';

function Fixture() {
  const [messages, setMessages] = useState<ServerMessage[]>([
    {
      seq: 44,
      type: 'NarrationCompleted',
      payload: {
        turnId: 'browser-turn',
        text: 'A sealed door opens.',
        words: 4,
      },
    },
  ]);
  return (
    <>
      <button
        type="button"
        onClick={() =>
          setMessages((current) => [
            ...current,
            {
              seq: 45,
              type: 'TurnReverted',
              payload: { revertedTurnId: 'browser-turn' },
            },
          ])
        }
      >
        Deliver rewind event
      </button>
      <NarrationLog
        messages={messages}
        onReport={async (messageRef, category, reason) => {
          const response = await fetch('/api/report-fixture', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ messageRef, category, reason }),
          });
          return response.ok ? null : 'Report failed';
        }}
      />
    </>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);
