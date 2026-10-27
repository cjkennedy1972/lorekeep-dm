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
          <p role="alert" className="form-error">
            {error}
          </p>
          <button onClick={load}>Retry loading games</button>
        </>
      ) : games === null ? (
        <>
          <p role="status" className="loading">
            <span className="spinner" aria-hidden="true" />
            Loading your games…
          </p>
          <div className="skeleton" aria-hidden="true" />
        </>
      ) : games.length ? (
        <ul aria-label="Your games" className="games-list">
          {games.map((game) => (
            <li key={game.id} className="game-card">
              <Link
                className="button game-card__resume"
                to={`/rooms/${game.id}/game`}
              >
                Resume {game.name}
              </Link>
              <span className="game-card__meta">
                {game.status} · {game.difficulty} · Level{' '}
                {game.startingLevel ?? '?'}
              </span>
              {game.recap && (
                <p className="game-card__recap">Previously on: {game.recap}</p>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p>You have no games yet.</p>
      )}
      <div className="page-links">
        <p>
          <Link className="button" to="/start">
            Start a solo game
          </Link>
        </p>
        <p>
          <Link to="/characters/new">Build a character</Link>
        </p>
        <p>
          Have an invite code? <Link to="/join">Join a table</Link>
        </p>
      </div>
    </section>
  );
}
