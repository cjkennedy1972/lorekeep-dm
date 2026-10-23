import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import type { Seat } from '@game/schema';
import { api, http, type RoomInfo } from '../api';
import { ConnectionStatus } from '../room/ConnectionStatus';
import { useRoom } from '../room/useRoom';
import { MatureOptOutField, useMatureOptOut } from './MatureOptOut';

const PRESENCE: Record<Seat['presence'], string> = {
  connected: 'connected',
  returning: 'returning',
  disconnected: 'disconnected',
  online: 'online',
  away: 'away',
  offline: 'offline',
  unknown: 'unknown',
  revoked: 'left',
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
  const nav = useNavigate();
  const minted = (useLocation().state as { room?: RoomInfo } | null)?.room;
  const [room, setRoom] = useState<RoomInfo | null>(
    minted && minted.id === id ? minted : null,
  );
  const [missing, setMissing] = useState(false);
  const [copied, setCopied] = useState('');

  useEffect(() => {
    // The plaintext code exists only in the create response; drop it from history state so a reload never replays it.
    if (minted) nav('.', { replace: true, state: null });
    if (room) return;
    void api<{ room: RoomInfo }>(`/api/rooms/${id}`).then((r) =>
      r.ok ? setRoom(r.data.room) : setMissing(true),
    );
  }, [id]);

  const live = useRoom({
    baseUrl: http.base,
    sessionId: id,
    fetchImpl: (...a) => http.fetch(...a),
    WebSocketImpl: http.WebSocket,
  });
  const seats = live.room?.seats ?? [];
  const round = live.room?.round;
  const announcement = usePresenceAnnouncement(seats);
  const content = useMatureOptOut();
  const [contentNote, setContentNote] = useState('');
  const [tierCap, setTierCap] = useState<'family' | 'standard' | null>(
    room?.tierCap ?? null,
  );
  const [tierNote, setTierNote] = useState('');

  useEffect(() => {
    setTierCap(room?.tierCap ?? null);
  }, [room?.id, room?.tierCap]);

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
  async function changeOptOut(optOut: boolean) {
    setContentNote(
      (await content.save(optOut)) ? 'Content setting saved.' : '',
    );
  }
  async function changeTierCap(value: string) {
    const next = value === 'mature' ? null : (value as 'family' | 'standard');
    const r = await api<{ tier: 'family' | 'standard' | null }>(
      `/api/sessions/${id}/content-tier`,
      { tier: next },
      'PATCH',
    );
    if (r.ok) {
      setTierCap(r.data.tier);
      setTierNote('Table setting saved.');
    } else setTierNote(r.message);
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
      <p>
        <Link to={`/rooms/${id}/game`}>Enter game</Link>
      </p>
      <h2 id="seats-heading">Players ({seats.length} of 6)</h2>
      <ul aria-labelledby="seats-heading" className="seats">
        {seats.map((s) => {
          const eligible = round?.eligibleSeatIds.includes(s.seatId) ?? false;
          const submitted =
            round?.submissions.some((item) => item.seatId === s.seatId) ??
            false;
          return (
            <li key={s.seatId} data-presence={s.presence}>
              {s.displayName}{' '}
              <span className="presence">({PRESENCE[s.presence]})</span>
              {eligible && (
                <span className="round-ready">
                  {' '}
                  {submitted ? 'submitted this round' : 'waiting for action'}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
      <section aria-labelledby="rules-heading">
        <h2 id="rules-heading">Table rules</h2>
        <p>
          Rounds: <strong>{live.room?.roundsEnabled ? 'on' : 'off'}</strong>.
          Round timer:{' '}
          <strong>
            {live.room?.roundDurationMs === undefined
              ? 'default'
              : live.room.roundDurationMs === null
                ? 'no time limit'
                : `${live.room.roundDurationMs / 1000} seconds`}
          </strong>
          . Content tier:{' '}
          {tierCap === null
            ? 'Mature (default)'
            : tierCap === 'standard'
              ? 'Standard'
              : 'Family'}
          .
        </p>
        {live.room?.paused && <p role="status">The table is paused.</p>}
        <p>
          Anyone at the table can use the X-card or pause in the game at any
          time.
        </p>
      </section>
      <section aria-labelledby="content-heading">
        <h2 id="content-heading">Content settings</h2>
        <p>
          Table setting:{' '}
          <strong>
            {tierCap === null
              ? 'Mature (default)'
              : tierCap === 'standard'
                ? 'Standard'
                : 'Family'}
          </strong>
          .
        </p>
        {tierCap === null ? (
          <p>
            Mature is on by default. It includes graphic violence, dark themes,
            strong language, and innuendo or allusion. You can opt out of Mature
            content below. Explicit sexual content is out of scope, and the hard
            safety floor is fixed.
          </p>
        ) : (
          <p>
            The {tierCap === 'standard' ? 'Standard' : 'Family'} cap is in
            effect; Mature-tier content is unavailable under this cap. Your
            personal Mature opt-out preference is saved separately and remains
            in effect if the table cap later changes. Explicit sexual content is
            out of scope, and the hard safety floor is fixed.
          </p>
        )}
        {room.isHost && (
          <div>
            <label htmlFor="host-tier-cap">Table content tier</label>
            <select
              id="host-tier-cap"
              value={tierCap ?? 'mature'}
              onChange={(e) => void changeTierCap(e.target.value)}
            >
              <option value="mature">Mature (default)</option>
              <option value="standard">Standard</option>
              <option value="family">Family</option>
            </select>
            <p role="status" aria-live="polite">
              {tierNote}
            </p>
          </div>
        )}
        {content.optOut !== undefined && (
          <MatureOptOutField
            checked={content.optOut}
            tierCap={tierCap}
            onChange={(v) => void changeOptOut(v)}
          />
        )}
        <p role={content.error ? 'alert' : 'status'}>
          {content.error || contentNote}
        </p>
      </section>
      {room.isHost && (
        <section aria-labelledby="invite-heading">
          <h2 id="invite-heading">Invite players</h2>
          {room.code ? (
            <>
              <p>
                Code: <strong>{room.code}</strong>
              </p>
              <label htmlFor="invite-link">Invite link</label>
              <input id="invite-link" readOnly value={link} />
            </>
          ) : (
            <p>
              For security the invite link is only shown when it is created and
              cannot be shown again. Create a new link to share; the previous
              link will stop working.
            </p>
          )}
          <div className="actions">
            {room.code && (
              <button type="button" onClick={copy}>
                Copy invite link
              </button>
            )}
            <button type="button" onClick={regenerate}>
              {room.code ? 'Regenerate link' : 'Create new invite link'}
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
