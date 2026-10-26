// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { describe, expect, it, vi } from 'vitest';
import {
  AreaAim,
  compass,
  type AreaOption,
} from '../src/features/map/AreaAim.js';

const burning: AreaOption = {
  spellId: 'spell:burning-hands',
  optionId: 'area:burning-hands:2,2:1,0',
  anchor: { x: 2, y: 2 },
  direction: { x: 1, y: 0 },
  cells: [{ x: 2, y: 2 }],
  affected: [
    { id: 'ent_goblin', relation: 'enemy' },
    { id: 'ent_aria', relation: 'ally' },
  ],
};
const empty: AreaOption = {
  spellId: 'spell:burning-hands',
  optionId: 'area:burning-hands:0,0:0,1',
  anchor: { x: 0, y: 0 },
  direction: { x: 0, y: 1 },
  cells: [],
  affected: [],
};
const names: Record<string, string> = {
  ent_goblin: 'Goblin',
  ent_aria: 'Aria',
};

function mount(areas = [burning, empty], onCast = vi.fn()) {
  render(
    <AreaAim
      areas={areas}
      nameOf={(id) => names[id] ?? id}
      onCast={onCast}
    />,
  );
  return { onCast };
}

describe('area aim list', () => {
  it('lists every aim as a radio labelled with its spell, 1-based anchor and facing', () => {
    mount();
    expect(
      screen.getByRole('radio', {
        name: /burning hands at 3, 3, facing east; 2 affected/,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('radio', {
        name: /burning hands at 1, 1, facing south; 0 affected/,
      }),
    ).toBeInTheDocument();
  });

  it('keeps Cast and Cancel disabled until an aim is chosen', () => {
    mount();
    expect(screen.getByRole('button', { name: 'Cast area' })).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'Cancel area aim' }),
    ).toBeDisabled();
    expect(
      screen.getByText('Choose an aim to preview who it affects.'),
    ).toBeInTheDocument();
  });

  it('previews the affected units by name and relation once an aim is selected', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(
      screen.getByRole('radio', { name: /facing east; 2 affected/ }),
    );
    expect(
      screen.getByText('2 affected: Goblin (enemy), Aria (ally).'),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole('radio', { name: /facing south; 0 affected/ }),
    );
    expect(screen.getByText('No units affected.')).toBeInTheDocument();
  });

  it('moves the selection with arrow keys inside the radio group (one tab stop)', async () => {
    const user = userEvent.setup();
    mount();
    await user.tab();
    expect(
      screen.getByRole('radio', { name: /facing east/ }),
    ).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(
      screen.getByRole('radio', { name: /facing south/ }),
    ).toBeChecked();
    expect(screen.getByText('No units affected.')).toBeInTheDocument();
  });

  it('Cast sends the chosen aim exactly once, and only that aim', async () => {
    const user = userEvent.setup();
    const { onCast } = mount();
    await user.click(
      screen.getByRole('radio', { name: /facing east; 2 affected/ }),
    );
    await user.click(screen.getByRole('button', { name: 'Cast area' }));
    expect(onCast).toHaveBeenCalledTimes(1);
    expect(onCast).toHaveBeenCalledWith(burning);
  });

  it('Cancel clears the selection without casting', async () => {
    const user = userEvent.setup();
    const { onCast } = mount();
    await user.click(
      screen.getByRole('radio', { name: /facing east; 2 affected/ }),
    );
    await user.click(
      screen.getByRole('button', { name: 'Cancel area aim' }),
    );
    expect(screen.getByRole('button', { name: 'Cast area' })).toBeDisabled();
    expect(onCast).not.toHaveBeenCalled();
  });

  it('Escape in the list clears the selection without casting', async () => {
    const user = userEvent.setup();
    const { onCast } = mount();
    await user.click(
      screen.getByRole('radio', { name: /facing east; 2 affected/ }),
    );
    await user.keyboard('{Escape}');
    expect(screen.getByRole('button', { name: 'Cast area' })).toBeDisabled();
    expect(onCast).not.toHaveBeenCalled();
  });

  it('passes axe checks', async () => {
    const { container } = render(
      <AreaAim
        areas={[burning, empty]}
        nameOf={(id) => names[id] ?? id}
        onCast={vi.fn()}
      />,
    );
    expect((await axe(container)).violations).toEqual([]);
  });
});

describe('compass', () => {
  it('names the eight unit directions and the zero vector', () => {
    expect(compass({ x: 1, y: 0 })).toBe('east');
    expect(compass({ x: -1, y: 0 })).toBe('west');
    expect(compass({ x: 0, y: -1 })).toBe('north');
    expect(compass({ x: 0, y: 1 })).toBe('south');
    expect(compass({ x: 1, y: 1 })).toBe('south-east');
    expect(compass({ x: -1, y: -1 })).toBe('north-west');
    expect(compass({ x: 0, y: 0 })).toBe('here');
  });
});
