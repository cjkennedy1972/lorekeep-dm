import { useRef, useState, type FormEvent } from 'react';
import type { ChatHistoryEntry, RoomState } from '@game/schema';
import { api } from '../../api.js';

interface ChatPanelProps {
  roomId: string;
  messages: ChatHistoryEntry[];
  room: RoomState;
  isHost: boolean;
  connected: boolean;
  error: string;
  onSend(text: string): boolean;
  onMute(seatId: string, muted: boolean): boolean;
}

export function ChatPanel(props: ChatPanelProps) {
  const [draft, setDraft] = useState('');
  const [status, setStatus] = useState('');
  const [reporting, setReporting] = useState<number | null>(null);
  const reportCategory = useRef<HTMLSelectElement>(null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = draft.normalize('NFC').trim();
    if (!text || Array.from(text).length > 2000) return;
    if (!props.onSend(text)) {
      setStatus('Not connected. Your message was not sent.');
      return;
    }
    setDraft('');
    setStatus('');
  };

  const report = async (entry: ChatHistoryEntry, form: HTMLFormElement) => {
    const data = new FormData(form);
    const result = await api(`/api/rooms/${props.roomId}/reports`, {
      messageRef: entry.seq,
      category: String(data.get('category') ?? 'other'),
      reason: String(data.get('reason') ?? ''),
    });
    setStatus(result.ok ? 'Report received. Thank you.' : result.message);
    if (result.ok) setReporting(null);
  };

  return (
    <section aria-label="Party chat" className="party-chat">
      <h2>Party chat (out of character)</h2>
      <p>Messages are moderated before they are saved or shown to the party.</p>
      <ol aria-label="Party chat messages">
        {props.messages.map((entry) => {
          const seat = props.room.seats.find(
            (candidate) => candidate.seatId === entry.message.seatId,
          );
          return (
            <li key={entry.message.messageId}>
              <p>
                <strong>{seat?.displayName ?? 'Player'}:</strong>{' '}
                {entry.message.text}
              </p>
              <button
                type="button"
                onClick={() => {
                  setReporting(entry.seq);
                  requestAnimationFrame(() => reportCategory.current?.focus());
                }}
              >
                Report message
              </button>
              {props.isHost && seat && (
                <button
                  type="button"
                  onClick={() => props.onMute(seat.seatId, !seat.chatMuted)}
                  disabled={!props.connected}
                >
                  {seat.chatMuted ? 'Unmute' : 'Mute'} {seat.displayName} in
                  chat
                </button>
              )}
              {reporting === entry.seq && (
                <form
                  aria-label="Report chat message"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void report(entry, event.currentTarget);
                  }}
                >
                  <label>
                    Category
                    <select
                      ref={reportCategory}
                      name="category"
                      defaultValue="other"
                    >
                      <option value="harassment">Harassment</option>
                      <option value="hate">Hate</option>
                      <option value="sexual">Sexual content</option>
                      <option value="threat_or_self_harm">
                        Threat or self-harm
                      </option>
                      <option value="underage">Underage user</option>
                      <option value="other">Other</option>
                    </select>
                  </label>
                  <label>
                    Optional details
                    <textarea name="reason" maxLength={500} />
                  </label>
                  <button type="submit">Submit report</button>
                  <button type="button" onClick={() => setReporting(null)}>
                    Cancel
                  </button>
                </form>
              )}
            </li>
          );
        })}
      </ol>
      <form aria-label="Send party chat message" onSubmit={submit}>
        <label>
          Message
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.currentTarget.value)}
            maxLength={8000}
            disabled={!props.connected}
          />
        </label>
        <button
          type="submit"
          disabled={
            !props.connected ||
            !draft.trim() ||
            Array.from(draft.normalize('NFC').trim()).length > 2000
          }
        >
          Send chat
        </button>
      </form>
      <p role="status" aria-live="polite">
        {props.error || status}
      </p>
      <p>
        Pause stops chat for players; use Report or ask the host to mute for
        individual messages; X-card is an anonymous signal to the table.
      </p>
    </section>
  );
}
