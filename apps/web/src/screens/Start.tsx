import { useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Character } from '@game/schema';
import { api } from '../api';
import {
  buildQuickCharacter,
  QuickBuild,
} from '../features/character/QuickBuild';
import { gameStore } from '../state/store';
import { CreationWizard } from '../features/character/CreationWizard';

const ADVENTURE = 'adventure:01-hollow-under-marrowfell';
export function Start() {
  const [name, setName] = useState('');
  const [difficulty, setDifficulty] = useState('moderate');
  const [level, setLevel] = useState('1');
  const [creation, setCreation] = useState<'quick' | 'wizard'>('quick');
  const [error, setError] = useState('');
  const [nameError, setNameError] = useState('');
  const [busy, setBusy] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  async function create(character?: Character) {
    setError('');
    const gameName = name.trim();
    if (!gameName) {
      setNameError('Enter a name for your game.');
      nameRef.current?.focus();
      return;
    }
    const selectedCharacter = character ?? gameStore.getState().character;
    let characterToCreate = selectedCharacter
      ? { ...selectedCharacter, level: Number(level) }
      : undefined;
    if (!characterToCreate) {
      try {
        characterToCreate = {
          ...buildQuickCharacter(undefined, Number(level)),
        };
      } catch {
        // Quick build is best-effort; the server still supports its default hero.
      }
    }
    setBusy(true);
    const result = await api<{ game: { id: string } }>('/api/tables', {
      name: gameName,
      adventureId: ADVENTURE,
      difficulty,
      startingLevel: Number(level),
      ...(characterToCreate ? { character: characterToCreate } : {}),
    });
    setBusy(false);
    if (result.ok) navigate(`/rooms/${result.data.game.id}/game`);
    else {
      const details = Array.isArray(result.data?.details)
        ? result.data.details
            .map((detail) => {
              if (typeof detail !== 'object' || detail === null) return '';
              const item = detail as { path?: unknown; code?: unknown };
              return typeof item.path === 'string' &&
                typeof item.code === 'string'
                ? `${item.path.replace(/^character\./, '')}: ${item.code.replaceAll('_', ' ')}`
                : '';
            })
            .filter(Boolean)
        : [];
      setError(
        details.length ? `Character: ${details.join('; ')}` : result.message,
      );
    }
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
      <form className="form" onSubmit={submit} noValidate>
        <div className="field">
          <label htmlFor="game-name">Game name</label>
          <input
            id="game-name"
            ref={nameRef}
            required
            maxLength={80}
            value={name}
            aria-invalid={nameError ? true : undefined}
            aria-describedby={nameError ? 'game-name-error' : undefined}
            onChange={(e) => {
              setName(e.target.value);
              setNameError('');
            }}
          />
          {nameError && (
            <p id="game-name-error" className="field-error">
              {nameError}
            </p>
          )}
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
            onChange={(e) => {
              setLevel(e.target.value);
              // A hero is sized for the level it was built at; drop it so the next create builds at this level.
              gameStore.setCharacter(null);
            }}
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
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        {creation === 'quick' && (
          <button type="submit" disabled={busy}>
            {busy ? 'Creating game…' : 'Create solo game'}
          </button>
        )}
      </form>
      <div hidden={creation !== 'quick'}>
        <QuickBuild startingLevel={Number(level)} />
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
