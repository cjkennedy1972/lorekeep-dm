import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Character } from '@game/schema';
import { api } from '../api';
import { QuickBuild } from '../features/character/QuickBuild';
import { CreationWizard } from '../features/character/CreationWizard';

const ADVENTURE = 'adventure:01-hollow-under-marrowfell';
export function Start() {
  const [name, setName] = useState('');
  const [difficulty, setDifficulty] = useState('moderate');
  const [level, setLevel] = useState('1');
  const [creation, setCreation] = useState<'quick' | 'wizard'>('quick');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  async function create(character?: Character) {
    setError('');
    setBusy(true);
    const result = await api<{ game: { id: string } }>('/api/tables', {
      name,
      adventureId: ADVENTURE,
      difficulty,
      startingLevel: Number(level),
      character,
    });
    setBusy(false);
    if (result.ok) navigate(`/rooms/${result.data.game.id}/game`);
    else setError(result.message);
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    void create();
  }
  return (
    <section aria-labelledby="start-title">
      <h1 id="start-title">Start a solo game</h1>
      <p>
        Begin <strong>The Hollow Under Marrowfell</strong>, your first
        adventure.
      </p>
      <form className="form" onSubmit={submit}>
        <div className="field">
          <label htmlFor="game-name">Game name</label>
          <input
            id="game-name"
            required
            maxLength={80}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="difficulty">Difficulty</label>
          <select
            id="difficulty"
            value={difficulty}
            onChange={(e) => setDifficulty(e.target.value)}
          >
            <option value="easy">Easy</option>
            <option value="moderate">Moderate</option>
            <option value="hard">Hard</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="starting-level">Starting level</label>
          <select
            id="starting-level"
            value={level}
            onChange={(e) => setLevel(e.target.value)}
          >
            {[1, 2, 3, 4, 5].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>
        <fieldset>
          <legend>Character creation</legend>
          <label>
            <input
              type="radio"
              name="character-creation"
              checked={creation === 'quick'}
              onChange={() => setCreation('quick')}
            />{' '}
            Quick build
          </label>{' '}
          <label>
            <input
              type="radio"
              name="character-creation"
              checked={creation === 'wizard'}
              onChange={() => setCreation('wizard')}
            />{' '}
            Guided wizard
          </label>
        </fieldset>
        {error && <p role="alert">{error}</p>}
        {creation === 'quick' && (
          <button type="submit" disabled={busy}>
            {busy ? 'Creating game…' : 'Create solo game'}
          </button>
        )}
      </form>
      <div hidden={creation !== 'quick'}>
        <QuickBuild
          onBuild={(character) =>
            void create({ ...character, level: Number(level) })
          }
        />
      </div>
      {creation === 'wizard' && (
        <CreationWizard
          onSave={(character) =>
            void create({ ...character, level: Number(level) })
          }
        />
      )}
    </section>
  );
}
