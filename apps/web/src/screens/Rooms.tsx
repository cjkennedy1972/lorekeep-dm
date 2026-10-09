import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';

type Game = {
  id: string;
  name: string;
  status: string;
  adventureId: string;
  difficulty: string;
  lastActiveAt: string;
  recap: string;
};
export function Rooms() {
  const [games, setGames] = useState<Game[] | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  useEffect(() => {
    void api<{ games: Game[] }>('/api/tables').then((r) =>
      setGames(r.ok ? r.data.games : []),
    );
  }, []);
  async function create(e: FormEvent) {
    e.preventDefault();
    setError('');
    const r = await api<{ game: Game }>('/api/tables', {
      name,
      adventureId: 'adventure:fixture-1',
      difficulty: 'moderate',
      startingLevel: 1,
    });
    if (r.ok) return navigate(`/rooms/${r.data.game.id}`);
    setError(r.message);
    input.current?.focus();
  }
  return (
    <>
      <h1>My games</h1>
      {games === null ? (
        <p role="status">Loading your games…</p>
      ) : games.length ? (
        <ul aria-label="Your games">
          {games.map((game) => (
            <li key={game.id}>
              <Link to={`/rooms/${game.id}`}>{game.name}</Link>{' '}
              <span>
                {game.status} · {game.difficulty}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p>You have no games yet.</p>
      )}
      <h2>Start a solo game</h2>
      <p>
        The first adventure is a temporary sample while the authored adventure
        arrives.
      </p>
      <form onSubmit={create} noValidate className="form">
        <div className="field">
          <label htmlFor="room-name">Game name</label>
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
        <button type="submit">Create solo game</button>
      </form>
      <p>
        <Link to="/characters/new">Build a character</Link>
      </p>
      <p>
        Have an invite code? <Link to="/join">Join a table</Link>
      </p>
    </>
  );
}
