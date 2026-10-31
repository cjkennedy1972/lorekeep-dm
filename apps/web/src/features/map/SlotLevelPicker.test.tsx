// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';
import { SlotLevelPicker } from './SlotLevelPicker.js';

test('offers cantrip and each available slot level, and reports the chosen one', async () => {
  const onChange = vi.fn();
  render(<SlotLevelPicker levels={[0, 1, 2]} value={1} onChange={onChange} />);
  const select = screen.getByLabelText('Spell slot');
  expect(select).toHaveValue('1');
  expect(
    screen.getByRole('option', { name: 'Cantrip (no slot)' }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole('option', { name: 'Level 2 slot' }),
  ).toBeInTheDocument();
  await userEvent.selectOptions(select, '2');
  expect(onChange).toHaveBeenCalledWith(2);
});
