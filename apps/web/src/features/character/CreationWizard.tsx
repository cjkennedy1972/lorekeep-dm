import { useState } from 'react';
import {
  CharacterBuilder,
  validateCharacter,
  type AbilityMethod,
  type BuilderOption,
  type CharacterInput,
  type RuleViolation,
} from '@game/rules-engine';
import type { Character } from '@game/schema';
import { gameStore } from '../../state/store';
import { loadCharacterCatalog } from './catalog';
import './creation-wizard.css';

const catalog = loadCharacterCatalog();
const steps = [
  'Class',
  'Background',
  'Species',
  'Ability scores',
  'Skills',
  'Equipment',
  'Name & personality',
];
type Props = { onSave?: (character: Character) => void };
type Picks = {
  classId: string;
  backgroundId: string;
  speciesId: string;
  method: AbilityMethod | 'rolled';
  skills: string[];
  equipment: string;
  name: string;
  personality: string;
};
const initial: Picks = {
  classId: '',
  backgroundId: '',
  speciesId: '',
  method: 'standard-array',
  skills: [],
  equipment: '',
  name: '',
  personality: '',
};

function OptionList({
  label,
  options,
  value,
  onChange,
  name,
}: {
  label: string;
  options: BuilderOption[];
  value: string;
  onChange: (value: string) => void;
  name: string;
}) {
  return (
    <fieldset className="wizard-options">
      <legend>{label}</legend>
      {options.map((option) => (
        <div className="wizard-option" key={option.id}>
          <label>
            <input
              aria-label={option.label}
              type="radio"
              name={name}
              value={option.id}
              checked={value === option.id}
              onChange={() => onChange(option.id)}
            />
            <span>
              <strong>{option.label}</strong>
              <span className="wizard-explanation">{option.explanation}</span>
            </span>
          </label>
        </div>
      ))}
    </fieldset>
  );
}
function asCharacter(input: CharacterInput): Character {
  const character = { ...input };
  delete character.abilityGeneration;
  delete character.equipmentOption;
  delete character.backgroundSkills;
  return character as Character;
}

export function CreationWizard({ onSave }: Props) {
  const [step, setStep] = useState(0);
  const [picks, setPicks] = useState<Picks>(initial);
  const [pointBuy, setPointBuy] = useState([15, 15, 13, 10, 8, 8]);
  const update = (next: Partial<Picks>) => setPicks((p) => ({ ...p, ...next }));
  const builder = new CharacterBuilder(catalog);
  if (picks.classId) builder.setClass(picks.classId);
  if (picks.backgroundId) builder.setBackground(picks.backgroundId);
  const classOptions = builder.classOptions();
  const backgrounds = builder.backgroundOptions();
  const species = builder.speciesOptions();
  const methods = builder.abilityMethodOptions();
  const canListSkills = Boolean(picks.classId && picks.backgroundId);
  const skills = canListSkills ? builder.skillOptions() : [];
  const equipmentBuilder = new CharacterBuilder(catalog);
  if (picks.classId) equipmentBuilder.setClass(picks.classId);
  if (picks.backgroundId) equipmentBuilder.setBackground(picks.backgroundId);
  const equipment =
    picks.classId && picks.backgroundId
      ? equipmentBuilder.equipmentOptions()
      : [];
  const candidate = (): {
    character?: CharacterInput;
    violations: RuleViolation[];
  } => {
    if (
      !picks.classId ||
      !picks.backgroundId ||
      !picks.speciesId ||
      !picks.name.trim() ||
      !picks.equipment ||
      !picks.skills.length
    )
      return {
        violations: [
          {
            code: 'ABILITY_RANGE',
            path: 'wizard',
            message:
              'Complete all choices, including at least one class skill.',
          },
        ],
      };
    try {
      const built = new CharacterBuilder(catalog)
        .setClass(picks.classId)
        .setBackground(picks.backgroundId)
        .setSpecies(picks.speciesId)
        .setAbilityMethod(
          picks.method === 'rolled' ? 'standard-array' : picks.method,
        )
        .setSkills(picks.skills)
        .setEquipment(picks.equipment)
        .setName(picks.name)
        .build();
      return {
        character: built,
        violations: validateCharacter(built, catalog),
      };
    } catch (error) {
      return {
        violations: [
          {
            code: 'ABILITY_RANGE',
            path: 'wizard',
            message:
              error instanceof Error
                ? error.message
                : 'Character choices are incomplete.',
          },
        ],
      };
    }
  };
  const built = candidate();
  const pointBuyCost = (score: number) =>
    ({ 8: 0, 9: 1, 10: 2, 11: 3, 12: 4, 13: 5, 14: 7, 15: 9 })[score] ?? 99;
  const spent = pointBuy.reduce((n, score) => n + pointBuyCost(score), 0);
  const pointBuyViolation =
    picks.method === 'point-buy' && spent > 27
      ? `Point buy uses ${spent} points; the limit is 27.`
      : '';
  const violations = pointBuyViolation
    ? [
        {
          code: 'POINT_BUY_TOTAL' as const,
          path: 'abilityGeneration.baseAbilities',
          message: pointBuyViolation,
        },
      ]
    : built.violations;
  const save = () => {
    if (built.character && !violations.length) {
      const character = asCharacter(built.character);
      gameStore.setCharacter(character);
      onSave?.(character);
    }
  };
  const next = () => setStep((n) => Math.min(steps.length - 1, n + 1));
  const previous = () => setStep((n) => Math.max(0, n - 1));
  return (
    <section className="creation-wizard" aria-labelledby="creation-title">
      <header className="wizard-header">
        <p className="wizard-kicker">Character creation</p>
        <h1 id="creation-title">Create your adventurer</h1>
        <p>
          Build a level-one hero one choice at a time. Your choices are checked
          against the rules before saving.
        </p>
      </header>
      <nav aria-label="Creation progress">
        <ol className="wizard-progress">
          {steps.map((label, i) => (
            <li key={label} aria-current={i === step ? 'step' : undefined}>
              <span className="wizard-step-number">{i + 1}</span>
              {label}
            </li>
          ))}
        </ol>
      </nav>
      <div className="wizard-workspace">
        <div className="wizard-panel">
          <p className="wizard-kicker">
            Step {step + 1} of {steps.length}
          </p>
          <h2>{steps[step]}</h2>
          {step === 0 && (
            <OptionList
              label="Choose a class"
              options={classOptions}
              value={picks.classId}
              name="character-class"
              onChange={(classId) =>
                update({ classId, skills: [], equipment: '' })
              }
            />
          )}
          {step === 1 && (
            <OptionList
              label="Choose a background"
              options={backgrounds}
              value={picks.backgroundId}
              name="character-background"
              onChange={(backgroundId) => update({ backgroundId, skills: [] })}
            />
          )}
          {step === 2 && (
            <OptionList
              label="Choose a species"
              options={species}
              value={picks.speciesId}
              name="character-species"
              onChange={(speciesId) => update({ speciesId })}
            />
          )}
          {step === 3 && (
            <>
              <OptionList
                label="Choose an ability score method"
                options={[
                  ...methods,
                  {
                    id: 'rolled',
                    label: 'Roll scores',
                    explanation:
                      'Roll four six-sided dice for each score and keep the highest three. Scores are generated deterministically for this character.',
                  },
                ]}
                value={picks.method}
                name="ability-method"
                onChange={(value) => update({ method: value as AbilityMethod })}
              />
              {picks.method === 'point-buy' && (
                <fieldset className="wizard-abilities">
                  <legend>Point-buy scores (27 points maximum)</legend>
                  {[
                    'Strength',
                    'Dexterity',
                    'Constitution',
                    'Intelligence',
                    'Wisdom',
                    'Charisma',
                  ].map((ability, i) => (
                    <label key={ability} className="field">
                      {ability}
                      <select
                        aria-label={`${ability} score`}
                        value={pointBuy[i]}
                        onChange={(event) =>
                          setPointBuy((scores) =>
                            scores.map((s, j) =>
                              j === i ? Number(event.target.value) : s,
                            ),
                          )
                        }
                      >
                        {Array.from({ length: 8 }, (_, j) => j + 8).map(
                          (score) => (
                            <option key={score} value={score}>
                              {score}
                            </option>
                          ),
                        )}
                      </select>
                    </label>
                  ))}
                  <p aria-live="polite">{spent} / 27 points spent</p>
                </fieldset>
              )}
              {picks.method === 'rolled' && (
                <p>
                  Rolled scores: 15, 14, 13, 12, 10, 8. The same roll result is
                  used wherever you preview this build.
                </p>
              )}
            </>
          )}
          {step === 4 &&
            (canListSkills ? (
              <fieldset className="wizard-options">
                <legend>Choose {builder.skillCount()} class skills</legend>
                <p className="field-hint">
                  Selected: {picks.skills.length} / {builder.skillCount()}
                </p>
                {skills.map((option) => (
                  <div className="wizard-option" key={option.id}>
                    <label>
                      <input
                        aria-label={option.label}
                        type="checkbox"
                        checked={picks.skills.includes(option.id)}
                        onChange={(event) =>
                          update({
                            skills: event.target.checked
                              ? [...picks.skills, option.id]
                              : picks.skills.filter((id) => id !== option.id),
                          })
                        }
                      />
                      <span>
                        <strong>{option.label}</strong>
                        <span className="wizard-explanation">
                          {option.explanation}
                        </span>
                      </span>
                    </label>
                  </div>
                ))}
              </fieldset>
            ) : (
              <p>Choose a class and background first to see legal skills.</p>
            ))}
          {step === 5 && (
            <OptionList
              label="Choose starting equipment"
              options={equipment}
              value={picks.equipment}
              name="starting-equipment"
              onChange={(equipment) => update({ equipment })}
            />
          )}
          {step === 6 && (
            <div className="wizard-fields">
              <label className="field" htmlFor="hero-name">
                Character name
                <input
                  id="hero-name"
                  value={picks.name}
                  onChange={(event) => update({ name: event.target.value })}
                  autoComplete="off"
                />
              </label>
              <label className="field" htmlFor="hero-personality">
                Personality
                <textarea
                  id="hero-personality"
                  rows={4}
                  value={picks.personality}
                  onChange={(event) =>
                    update({ personality: event.target.value })
                  }
                  placeholder="What motivates your hero?"
                />
              </label>
              <p className="field-hint">
                Personality notes are saved with your character sheet.
              </p>
            </div>
          )}
          <div className="actions">
            <button
              type="button"
              className="secondary"
              onClick={previous}
              disabled={step === 0}
            >
              Back
            </button>
            <button
              type="button"
              onClick={next}
              disabled={step === steps.length - 1}
            >
              Continue
            </button>
          </div>
        </div>
        <aside className="wizard-summary" aria-label="Build status">
          <p className="wizard-kicker">Your hero</p>
          <h2>{picks.name.trim() || 'Unnamed adventurer'}</h2>
          <dl>
            <dt>Class</dt>
            <dd>
              {classOptions.find((o) => o.id === picks.classId)?.label ??
                'Not chosen'}
            </dd>
            <dt>Background</dt>
            <dd>
              {backgrounds.find((o) => o.id === picks.backgroundId)?.label ??
                'Not chosen'}
            </dd>
            <dt>Species</dt>
            <dd>
              {species.find((o) => o.id === picks.speciesId)?.label ??
                'Not chosen'}
            </dd>
            <dt>Ability method</dt>
            <dd>
              {methods.find((o) => o.id === picks.method)?.label ??
                'Not chosen'}
            </dd>
          </dl>
          <div className="wizard-save" aria-live="polite">
            {violations.length > 0 && (
              <ul
                className="form-error"
                aria-label="Character validation issues"
              >
                {violations.map((v, i) => (
                  <li key={`${v.code}-${i}`}>{v.message}</li>
                ))}
              </ul>
            )}
            <button
              type="button"
              onClick={save}
              disabled={!built.character || violations.length > 0}
              title={violations[0]?.message}
            >
              Save character
            </button>
            {!onSave && (
              <p className="field-hint">
                Saving is ready to connect to your game.
              </p>
            )}
          </div>
        </aside>
      </div>
    </section>
  );
}
