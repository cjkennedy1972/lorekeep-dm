import { useEffect, useRef } from 'react';
import { combatOutcomeCopy } from './combatOutcome.js';
import './combat-end.css';

type Props = {
  outcome: string | undefined;
  onContinue: () => void;
};

/**
 * Replaces the combat bar once `CombatEnded` arrives. Focus moves to the result so keyboard users keep their place
 * after the Attack and End turn controls disappear.
 */
export function CombatEndCard({ outcome, onContinue }: Props) {
  const heading = useRef<HTMLHeadingElement>(null);
  const copy = combatOutcomeCopy(outcome);
  useEffect(() => {
    heading.current?.focus();
  }, [outcome]);
  return (
    <section className="combat-end" aria-label="Combat result">
      <div role="status">
        <h2 ref={heading} tabIndex={-1} className="combat-end__title">
          {copy.title}
        </h2>
        <p className="combat-end__body">{copy.body}</p>
      </div>
      <button type="button" onClick={onContinue}>
        Continue
      </button>
    </section>
  );
}
