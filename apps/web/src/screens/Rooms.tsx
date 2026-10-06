import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, type RoomInfo } from '../api';

export function Rooms() {
  const [rooms, setRooms] = useState<RoomInfo[] | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    void api<{ rooms: RoomInfo[] }>('/api/rooms').then((r) =>
      setRooms(r.ok ? r.data.rooms : []),
    );
  }, []);

  async function create(e: FormEvent) {
    e.preventDefault();
    const r = await api<{ room: RoomInfo }>('/api/rooms', { name });
    if (r.ok) return navigate(`/rooms/${r.data.room.id}`);
    setError(r.message);
    input.current?.focus();
  }

  return (
    <>
      <h1>My tables</h1>
      {rooms === null ? (
        <p role="status">Loading your tables…</p>
      ) : rooms.length ? (
        <ul aria-label="Your tables">
          {rooms.map((r) => (
            <li key={r.id}>
              <Link to={`/rooms/${r.id}`}>{r.name}</Link>
            </li>
          ))}
        </ul>
      ) : (
        <p>You have no tables yet. Create one below, or open an invite link.</p>
      )}
      <h2>Create a table</h2>
      <form onSubmit={create} noValidate className="form">
        <div className="field">
          <label htmlFor="room-name">Table name</label>
          <input
            ref={input}
            id="room-name"
            value={name}
            maxLength={80}
            required
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? 'room-name-error' : undefined}
            onChange={(e) => setName(e.target.value)}
          />
          {error && (
            <p id="room-name-error" className="field-error" role="alert">
              {error}
            </p>
          )}
        </div>
        <button type="submit">Create table</button>
      </form>
      <p>
        Have an invite code? <Link to="/join">Join a table</Link>
      </p>
    </>
  );
}
