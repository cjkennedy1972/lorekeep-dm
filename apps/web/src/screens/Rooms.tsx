import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';

type Game = {
  id: string;
  name: string;
  status: string;
  adventureId: string;
  difficulty: string;
  startingLevel?: number;
  lastActiveAt: string;
  recap: string;
};
export function Rooms() {
  const [games, setGames] = useState<Game[] | null>(null);
  const [error, setError] = useState('');
  const load = () => {
    setGames(null);
    setError('');
    void api<{ games: Game[] }>('/api/tables').then((result) => {
      if (result.ok) setGames(result.data.games);
      else {
        setGames([]);
        setError(result.message);
      }
    });
  };
  useEffect(load, []);
  return (
    <section aria-labelledby="games-title">
      <h1 id="games-title">My games</h1>
      {error ? (
        <>
          <p role="alert">{error}</p>
          <button onClick={load}>Retry loading games</button>
        </>
      ) : games === null ? (
        <p role="status">Loading your games…</p>
      ) : games.length ? (
        <ul aria-label="Your games">
          {games.map((game) => (
            <li key={game.id}>
              <Link to={`/rooms/${game.id}/game`}>Resume {game.name}</Link>{' '}
              <span>
                {game.status} · {game.difficulty} · Level{' '}
                {game.startingLevel ?? '?'}
              </span>
              {game.recap && <p>Previously on: {game.recap}</p>}
            </li>
          ))}
        </ul>
      ) : (
        <p>You have no games yet.</p>
      )}
      <p>
        <Link to="/start">Start a solo game</Link>
      </p>
      <p>
        <Link to="/characters/new">Build a character</Link>
      </p>
      <p>
        Have an invite code? <Link to="/join">Join a table</Link>
      </p>
    </section>
  );
}
