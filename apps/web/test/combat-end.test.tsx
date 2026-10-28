// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CombatEndCard } from '../src/features/combat/CombatEndCard.js';
import { combatOutcomeCopy } from '../src/features/combat/combatOutcome.js';

describe('combat outcome copy', () => {
  it.each([
    ['party-victory', 'Victory', 'The last enemy is down.'],
    ['enemies-fled', 'Retreat', 'The enemies fled the field.'],
    ['party-defeated', 'Defeat', 'The party has fallen.'],
    ['dm-ended', 'Encounter ended', 'The storyteller ended the encounter.'],
  ])('%s reads as %s', (outcome, title, body) => {
    expect(combatOutcomeCopy(outcome)).toEqual({ title, body });
  });

  it('falls back to a neutral title for an outcome it does not know', () => {
    expect(combatOutcomeCopy('something-new').title).toBe('Combat over');
    expect(combatOutcomeCopy(undefined).title).toBe('Combat over');
  });
});

describe('CombatEndCard', () => {
  it('announces the result and continues back to exploration on request', async () => {
    const user = userEvent.setup();
    const onContinue = vi.fn();
    render(<CombatEndCard outcome="party-victory" onContinue={onContinue} />);

    expect(screen.getByRole('status')).toHaveTextContent('Victory');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it('moves focus to the result so keyboard users are not left on a removed control', () => {
    render(<CombatEndCard outcome="party-defeated" onContinue={() => {}} />);
    expect(screen.getByRole('heading', { name: 'Defeat' })).toHaveFocus();
  });
});
