import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  quickBuild,
  validateCharacter,
  type CharacterInput,
} from '@game/rules-engine';
import type { Character } from '@game/schema';
import { newCharacterId } from './id';
import { gameStore } from '../../state/store';
import { loadCharacterCatalog } from './catalog';
import { SaveToAccount } from './SaveToAccount';

const catalog = loadCharacterCatalog();
const classes = catalog.entries.filter((entry) => entry.kind === 'class');

export function buildQuickCharacter(
  classId?: string,
  startingLevel = 1,
): Character {
  const result = quickBuild(catalog, classId, 32, startingLevel);
  const violations = validateCharacter(result.character, catalog);
  if (violations.length)
    throw new Error(violations.map((v) => v.message).join('; '));
  const character = asCharacter(result.character);
  gameStore.setCharacter(character);
  return character;
}

function asCharacter(input: CharacterInput): Character {
  const character = { ...input, id: newCharacterId() };
  return character as Character;
}

/** Builds a legal character on this device. Saving it to the account is a separate, explicit step. */
export function QuickBuild({
  startingLevel = 1,
  classId: classIdProp,
  onClassChange,
}: {
  startingLevel?: number;
  /** Controlled class choice, so a parent can build with the same class the player sees. */
  classId?: string;
  onClassChange?: (classId: string) => void;
} = {}) {
  const [localClassId, setLocalClassId] = useState('');
  const classId = classIdProp ?? localClassId;
  const setClassId = onClassChange ?? setLocalClassId;
  const [built, setBuilt] = useState<Character | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  // A hero is sized for the level it was built at, so a new starting level means building again.
  useEffect(() => setBuilt(null), [startingLevel]);

  // The build button leaves the DOM, so move focus to the result heading.
  useLayoutEffect(() => {
    if (built) headingRef.current?.focus();
  }, [built]);

  if (built) {
    return (
      <section aria-labelledby="quick-build-title">
        <h1 id="quick-build-title" ref={headingRef} tabIndex={-1}>
          Your hero is built
        </h1>
        <p>
          {built.name} is built as a level {built.level} character. It is not
          saved to your account yet.
        </p>
        <Link to="/characters/edit">Edit this character in the wizard</Link>
        <SaveToAccount character={built} />
      </section>
    );
  }

  return (
    <section aria-labelledby="quick-build-title">
      <h1 id="quick-build-title">Quick build</h1>
      <p>
        Choose a class, or let us pick one. You can edit every choice
        afterwards.
      </p>
      <label htmlFor="quick-build-class">Class (optional)</label>
      <select
        id="quick-build-class"
        value={classId}
        onChange={(event) => setClassId(event.target.value)}
      >
        <option value="">Choose for me</option>
        {classes.map((item) => (
          <option key={item.id} value={item.id}>
            {item.name}
          </option>
        ))}
      </select>
      <p className="field-hint">
        Building creates the character on this device only. You can save it to
        your account afterwards.
      </p>
      <button
        type="button"
        onClick={() =>
          setBuilt(buildQuickCharacter(classId || undefined, startingLevel))
        }
      >
        Build character
      </button>
    </section>
  );
}
