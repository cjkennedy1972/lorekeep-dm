import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SandboxCombat } from '../src/routes/sandboxCombat';

describe('sandbox combat names', () => {
  it('shows goblins by display name, never by their raw entity ids', () => {
    const { container } = render(<SandboxCombat />);
    const tracker = screen.getByRole('region', { name: 'Initiative tracker' });
    const rows = within(tracker)
      .getAllByRole('listitem')
      .map((item) => item.textContent ?? '');
    expect(rows.filter((row) => row.startsWith('Goblin '))).toHaveLength(2);
    expect(rows.some((row) => row.includes('Goblin 1'))).toBe(true);
    expect(rows.some((row) => row.includes('Goblin 2'))).toBe(true);
    expect(container.textContent).not.toMatch(/goblin-\d/);
    expect(container.textContent).not.toMatch(/ent_/);
  });
});
