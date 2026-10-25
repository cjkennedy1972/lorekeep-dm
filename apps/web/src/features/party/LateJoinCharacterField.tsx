import { useId } from 'react';
import { Link } from 'react-router-dom';
import { loadCharacterCatalog } from '../character/catalog';
import { characterLabel, type OwnedCharacter } from './bindCharacter';

const catalog = loadCharacterCatalog();

interface Props {
  /** Owned characters from GET /api/me/characters; null while loading. */
  characters: OwnedCharacter[] | null;
  loadError: string;
  selectedId: string;
  disabled: boolean;
  onChange: (id: string) => void;
  onRetry: () => void;
}

/** Picks the account character a late joiner requests the table with. The host sees only its public card. */
export function LateJoinCharacterField({
  characters,
  loadError,
  selectedId,
  disabled,
  onChange,
  onRetry,
}: Props) {
  const selectId = useId();
  const hintId = `${selectId}-hint`;

  if (loadError)
    return (
      <p role="alert">
        {loadError}{' '}
        <button type="button" onClick={onRetry}>
          Try again
        </button>
      </p>
    );
  if (characters === null) return <p role="status">Loading your characters…</p>;
  if (characters.length === 0)
    return (
      <p>
        You have no characters on this account yet. A table that is already
        playing needs one to join.{' '}
        <Link to="/characters/new">Create a character</Link>.
      </p>
    );

  return (
    <div className="field">
      <label htmlFor={selectId}>Your character</label>
      <select
        id={selectId}
        value={selectedId}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        aria-describedby={hintId}
      >
        {characters.map((c) => (
          <option key={c.id} value={c.id}>
            {characterLabel(c, catalog)}
          </option>
        ))}
      </select>
      <p id={hintId} className="field-hint">
        Used if the table is already playing. The host approves the request
        after seeing only this character’s public card.
      </p>
    </div>
  );
}
