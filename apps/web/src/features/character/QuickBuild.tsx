import { useState } from 'react';
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

export function QuickBuild({
  onBuild,
  startingLevel = 1,
}: {
  onBuild?: (character: Character) => void;
  startingLevel?: number;
} = {}) {
  const [classId, setClassId] = useState('');
  const [saved, setSaved] = useState(false);
  const build = () => {
    const character = buildQuickCharacter(classId || undefined, startingLevel);
    if (onBuild) onBuild(character);
    else setSaved(true);
  };

  if (saved) {
    const built = gameStore.getState().character;
    return (
      <section aria-labelledby="quick-build-title">
        <h1 id="quick-build-title">Your hero is ready</h1>
        <p>
          {gameStore.getState().character?.name} was saved as a level-one
          character.
        </p>
        <Link to="/characters/edit">Edit this character in the wizard</Link>
        {built && <SaveToAccount character={built} />}
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
      <button type="button" onClick={build}>
        Build and save character
      </button>
    </section>
  );
}
