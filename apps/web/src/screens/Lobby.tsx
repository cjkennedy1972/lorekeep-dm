import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { Seat } from '@game/schema';
import { api, http, type RoomInfo } from '../api';
import { ConnectionStatus } from '../room/ConnectionStatus';
import { useRoom } from '../room/useRoom';

const PRESENCE: Record<Seat['presence'], string> = {
  online: 'online',
  away: 'away',
  offline: 'offline',
};

/** Polite announcements for presence changes and arrivals/departures. */
function usePresenceAnnouncement(seats: Seat[]) {
  const prev = useRef<Map<string, Seat> | null>(null);
  const [message, setMessage] = useState('');
  useEffect(() => {
    const last = prev.current;
    prev.current = new Map(seats.map((s) => [s.seatId, s]));
    if (!last) return;
    for (const s of seats) {
      const was = last.get(s.seatId);
      if (!was) setMessage(`${s.displayName} joined the table.`);
      else if (was.presence !== s.presence)
        setMessage(`${s.displayName} is now ${PRESENCE[s.presence]}.`);
    }
  }, [seats]);
  return message;
}

export function Lobby() {
  const { id } = useParams();
  const [room, setRoom] = useState<RoomInfo | null>(null);
  const [missing, setMissing] = useState(false);
  const [copied, setCopied] = useState('');

  useEffect(() => {
    void api<{ room: RoomInfo }>(`/api/rooms/${id}`).then((r) =>
      r.ok ? setRoom(r.data.room) : setMissing(true),
    );
  }, [id]);

  const live = useRoom({
    baseUrl: http.base,
    fetchImpl: (...a) => http.fetch(...a),
    WebSocketImpl: http.WebSocket,
  });
  const seats = live.room?.seats ?? [];
  const announcement = usePresenceAnnouncement(seats);

  if (missing) return <p role="alert">That table could not be found.</p>;
  if (!room) return <p role="status">Loading the lobby…</p>;

  const link = room.code ? `${location.origin}/join/${room.code}` : '';
  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
      setCopied('Invite link copied to clipboard.');
    } catch {
      setCopied('Could not copy automatically. Select the link and copy it.');
    }
  }
  async function regenerate() {
    const r = await api<{ room: RoomInfo }>(`/api/rooms/${id}/invite`, {});
    if (r.ok) {
      setRoom(r.data.room);
      setCopied('New invite link created. The old link no longer works.');
    }
  }

  return (
    <>
      <h1>{room.name}</h1>
      <ConnectionStatus status={live.status} />
      <h2 id="seats-heading">Players ({seats.length} of 6)</h2>
      <ul aria-labelledby="seats-heading" className="seats">
        {seats.map((s) => (
          <li key={s.seatId} data-presence={s.presence}>
            {s.displayName}{' '}
            <span className="presence">({PRESENCE[s.presence]})</span>
          </li>
        ))}
      </ul>
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
      {room.isHost && (
        <section aria-labelledby="invite-heading">
          <h2 id="invite-heading">Invite players</h2>
          <p>
            Code: <strong>{room.code}</strong>
          </p>
          <label htmlFor="invite-link">Invite link</label>
          <input id="invite-link" readOnly value={link} />
          <div className="actions">
            <button type="button" onClick={copy}>
              Copy invite link
            </button>
            <button type="button" onClick={regenerate}>
              Regenerate link
            </button>
          </div>
          <p role="status" aria-live="polite">
            {copied}
          </p>
        </section>
      )}
    </>
  );
}
