import type { RollBreakdown as RollBreakdownData } from '@game/rules-engine';

type RollEvent = {
  type: 'RollEvent';
  breakdown: RollBreakdownData;
  dc?: number;
  dcReason?: string;
};

type Props = {
  event: RollEvent;
};

const signed = (value: number) => (value > 0 ? `+${value}` : String(value));

/** A readable rendering of the deterministic breakdown stored on a RollEvent. */
export function RollBreakdown({ event }: Props) {
  const { breakdown, dc, dcReason } = event;
  const computation = [
    `${breakdown.expression}: ${breakdown.dice
      .map((die) => `${die.value}${die.kept ? '' : ' (dropped)'}`)
      .join(', ')}`,
    ...breakdown.modifiers.map(
      (modifier) => `${modifier.label} ${signed(modifier.value)}`,
    ),
    `total ${breakdown.total}`,
    ...(dc === undefined ? [] : [`DC ${dc}`]),
  ].join('; ');

  return (
    <section aria-label="Roll breakdown" className="roll-breakdown">
      <p aria-hidden="true">
        {breakdown.expression}:{' '}
        {breakdown.dice.map((die, index) => (
          <span key={`${index}-${die.value}`}>
            {index > 0 ? ', ' : ''}
            <span className={die.kept ? undefined : 'roll-breakdown__dropped'}>
              {die.value}
            </span>
            {!die.kept && <span> (dropped)</span>}
          </span>
        ))}
      </p>
      {breakdown.modifiers.length > 0 && (
        <ul aria-label="Modifiers">
          {breakdown.modifiers.map((modifier, index) => (
            <li key={`${modifier.label}-${index}`}>
              {modifier.label}: {signed(modifier.value)}
            </li>
          ))}
        </ul>
      )}
      <p>Total: {breakdown.total}</p>
      {dc !== undefined && (
        <div>
          <p>DC {dc}</p>
          {dcReason && (
            <details>
              <summary>Why DC {dc}?</summary>
              <p>{dcReason}</p>
            </details>
          )}
        </div>
      )}
      <span className="sr-only">{computation}</span>
    </section>
  );
}
