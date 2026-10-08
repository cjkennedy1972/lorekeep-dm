import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RollBreakdown } from '../src/RollBreakdown.js';

const event = {
  type: 'RollEvent' as const,
  breakdown: {
    expression: '1d20',
    dice: [
      { sides: 20, value: 4, kept: false },
      { sides: 20, value: 16, kept: true },
    ],
    modifiers: [{ label: 'Stealth (dex)', value: 3 }],
    total: 19,
  },
};

describe('RollBreakdown', () => {
  it('shows both advantage dice and identifies the dropped die', () => {
    const { container } = render(<RollBreakdown event={event} />);
    expect(screen.getByText('4')).toHaveClass('roll-breakdown__dropped');
    expect(container.textContent).toContain('4 (dropped)');
    expect(container.textContent).toContain('16');
  });

  it('discloses the stored reason for a check DC on demand', () => {
    render(
      <RollBreakdown
        event={{ ...event, dc: 15, dcReason: 'slick stone wall' }}
      />,
    );
    expect(screen.getByText('DC 15')).toBeInTheDocument();
    expect(screen.queryByText('slick stone wall')).not.toBeVisible();
    fireEvent.click(screen.getByText('Why DC 15?'));
    expect(screen.getByText('slick stone wall')).toBeVisible();
  });

  it('provides one text alternative for the complete computation', () => {
    render(
      <RollBreakdown
        event={{ ...event, dc: 15, dcReason: 'slick stone wall' }}
      />,
    );
    expect(
      screen.getByText(
        /1d20: 4 \(dropped\), 16; Stealth \(dex\) \+3; total 19; DC 15/,
      ),
    ).toBeInTheDocument();
  });
});
