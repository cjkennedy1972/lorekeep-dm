import { useSyncExternalStore, type ReactNode } from 'react';
import type { Character } from '@game/schema';
import { gameStore, type GameStore } from '../../state/gameStore';
import { loadCharacterCatalog } from './catalog';

export interface SheetProps {
  character?: Character | null;
  store?: GameStore;
  /** Shown under the empty state, e.g. a link to build or choose a character. */
  emptyAction?: ReactNode;
  /** True while the room state that supplies the character is still loading. */
  loading?: boolean;
  /** True when the room state never arrived; shown in place of the loading status. */
  loadFailed?: boolean;
  /** Offered with loadFailed so the player can try reconnecting. */
  onRetry?: () => void;
  /** False for a spectator with no seat at the table. Defaults to true. */
  seated?: boolean;
  /** The viewer's seat is the host seat. */
  isHost?: boolean;
  /** The viewer's seat has a bound party character whose sheet has not arrived yet. */
  hasBoundCharacter?: boolean;
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
const itemNames = new Map(
  loadCharacterCatalog()
    .entries.filter((entry) => entry.kind === 'equipment')
    .map((entry) => [entry.id, entry.name]),
);
/** Catalog names keep their punctuation; the slug id only drops it, so prefer the name. */
const itemLabel = (itemId: string) =>
  itemNames.get(itemId) ??
  itemId.replace(/^equipment:/, '').replaceAll('-', ' ');
const conditionLabels = new Map(
  loadCharacterCatalog()
    .entries.filter((entry) => entry.kind === 'condition')
    .map((entry) => [entry.id, entry.name.toLowerCase()]),
);

export function Sheet({
  character: suppliedCharacter,
  store = gameStore,
  emptyAction,
  loading = false,
  loadFailed = false,
  onRetry,
  seated = true,
  isHost = false,
  hasBoundCharacter = false,
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
      <section aria-labelledby="sheet-title" className="sheet-empty">
        <h1 id="sheet-title">Character sheet</h1>
        {loadFailed ? (
          <>
            <p role="alert">Your character hasn’t made it to the table yet.</p>
            {onRetry && (
              <button type="button" onClick={onRetry}>
                Try again
              </button>
            )}
          </>
        ) : loading || hasBoundCharacter ? (
          <p role="status" className="loading">
            <span className="spinner" aria-hidden="true" />
            Loading your character…
          </p>
        ) : !seated ? (
          <p>
            You’re watching this table. Your character sheet appears here once
            you take a seat.
          </p>
        ) : isHost ? (
          <>
            <p>
              You’re hosting without a character. Build or choose one to play,
              or keep running the table.
            </p>
            {emptyAction}
          </>
        ) : (
          <>
            <p>
              You don’t have a character at this table yet. Build or choose one
              to join the story.
            </p>
            {emptyAction}
          </>
        )}
      </section>
    );

  const ac = 10 + Math.floor((character.abilities.dex - 10) / 2);
  const conditions = character.conditions.flatMap((condition) => {
    const label = conditionLabels.get(condition.conditionId);
    return label ? [label.toLowerCase()] : [];
  });
  const hpRatio = character.hp.current / Math.max(character.hp.max, 1);
  const hpState = hpRatio <= 0.25 ? 'critical' : hpRatio <= 0.5 ? 'warn' : 'ok';
  const hpWord = { ok: 'Healthy', warn: 'Wounded', critical: 'Critical' }[
    hpState
  ];
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
            <span
              className="sheet-hp"
              aria-hidden="true"
              data-hp-state={hpState}
            >
              <span
                className="sheet-hp__fill"
                style={{
                  width: `${Math.max(0, Math.min(100, (character.hp.current / Math.max(character.hp.max, 1)) * 100))}%`,
                }}
              />
            </span>
            <span className="sheet-hp__text" data-hp-state={hpState}>
              {hpWord}
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
                {itemLabel(item.itemId)} × {item.qty}
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
