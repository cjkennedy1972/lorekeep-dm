import { useSyncExternalStore } from 'react';
import type { Character } from '@game/schema';
import { gameStore, type GameStore } from '../../state/gameStore';
import { loadCharacterCatalog } from './catalog';

export interface SheetProps {
  character?: Character | null;
  store?: GameStore;
}

const abilityNames = {
  str: 'Strength',
  dex: 'Dexterity',
  con: 'Constitution',
  int: 'Intelligence',
  wis: 'Wisdom',
  cha: 'Charisma',
} as const;
const modifier = (score: number) => {
  const value = Math.floor((score - 10) / 2);
  return `${value >= 0 ? '+' : ''}${value}`;
};
const conditionLabels = new Map(
  loadCharacterCatalog()
    .entries.filter((entry) => entry.kind === 'condition')
    .map((entry) => [entry.id, entry.name.toLowerCase()]),
);

export function Sheet({
  character: suppliedCharacter,
  store = gameStore,
}: SheetProps) {
  const state = useSyncExternalStore(
    store.subscribe,
    store.getState,
    store.getState,
  );
  const character =
    suppliedCharacter === undefined ? state.character : suppliedCharacter;
  const announcement = state.announcement;
  if (!character)
    return (
      <section aria-labelledby="sheet-title">
        <h1 id="sheet-title">Character sheet</h1>
        <p>No character selected.</p>
      </section>
    );

  const ac = 10 + Math.floor((character.abilities.dex - 10) / 2);
  const conditions = character.conditions.flatMap((condition) => {
    const label = conditionLabels.get(condition.conditionId);
    return label ? [label.toLowerCase()] : [];
  });
  const hpLabel = `Hit points ${character.hp.current} of ${character.hp.max}`;

  return (
    <section aria-labelledby="sheet-title" className="character-sheet">
      <h1 id="sheet-title">{character.name}</h1>
      <p className="sheet-subtitle">
        {character.classId.replace(/^class:/, '')} · Level {character.level}
      </p>
      <dl aria-label="Combat statistics" className="sheet-stats">
        <div>
          <dt>Armor Class</dt>
          <dd>{ac}</dd>
        </div>
        <div>
          <dt>Hit points</dt>
          <dd aria-label={hpLabel}>
            {character.hp.current} / {character.hp.max}
            {character.hp.temp > 0 ? ` (+${character.hp.temp} temp)` : ''}
            <span className="sheet-hp" aria-hidden="true">
              <span
                className="sheet-hp__fill"
                style={{
                  width: `${Math.max(0, Math.min(100, (character.hp.current / Math.max(character.hp.max, 1)) * 100))}%`,
                }}
              />
            </span>
          </dd>
        </div>
        <div className="sheet-stats__xp">
          <dt>Experience points</dt>
          <dd>0 XP</dd>
        </div>
      </dl>
      <section aria-labelledby="abilities-title">
        <h2 id="abilities-title">Abilities</h2>
        <dl className="sheet-abilities">
          {Object.entries(abilityNames).map(([key, label]) => {
            const score = character.abilities[key as keyof typeof abilityNames];
            return (
              <div key={key}>
                <dt>{label}</dt>
                <dd>
                  {score} ({modifier(score)})
                </dd>
              </div>
            );
          })}
        </dl>
      </section>
      <section aria-labelledby="conditions-title">
        <h2 id="conditions-title">Conditions</h2>
        {conditions.length ? (
          <ul className="sheet-conditions">
            {conditions.map((condition) => (
              <li key={condition}>{condition}</li>
            ))}
          </ul>
        ) : (
          <p>None</p>
        )}
      </section>
      <section aria-labelledby="slots-title">
        <h2 id="slots-title">Spell slots</h2>
        {Object.keys(character.slots).length ? (
          <ul className="sheet-slots">
            {Object.entries(character.slots)
              .sort(([a], [b]) => Number(a) - Number(b))
              .map(([level, slot]) => (
                <li key={level}>
                  <span>
                    Level {level}: {Math.max(0, slot.max - slot.used)} of{' '}
                    {slot.max} remaining
                  </span>
                  <span className="sheet-pips" aria-hidden="true">
                    {Array.from({ length: slot.max }, (_, pip) => (
                      <span
                        key={pip}
                        className={
                          pip < slot.max - slot.used
                            ? 'sheet-pip sheet-pip--full'
                            : 'sheet-pip'
                        }
                      />
                    ))}
                  </span>
                </li>
              ))}
          </ul>
        ) : (
          <p>None</p>
        )}
      </section>
      <section aria-labelledby="inventory-title">
        <h2 id="inventory-title">Inventory</h2>
        {character.equipment.length ? (
          <ul className="sheet-inventory">
            {character.equipment.map((item) => (
              <li key={item.itemId}>
                {item.itemId.replace(/^equipment:/, '').replaceAll('-', ' ')} ×{' '}
                {item.qty}
                {item.equipped ? ' (equipped)' : ''}
              </li>
            ))}
          </ul>
        ) : (
          <p>Empty</p>
        )}
      </section>
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {announcement}
      </div>
    </section>
  );
}
