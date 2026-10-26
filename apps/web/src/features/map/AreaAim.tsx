import type { GridPos } from '@game/schema';
import { useState } from 'react';

/** One legal aim of an area spell, as the server computes it in CombatOptions.areas (combatSpell.ts). */
export type AreaOption = {
  spellId: string;
  optionId: string;
  anchor: GridPos;
  direction: GridPos;
  cells: GridPos[];
  affected: { id: string; relation: 'ally' | 'enemy' }[];
};

type Props = {
  areas: AreaOption[];
  nameOf: (entityId: string) => string;
  onCast: (area: AreaOption) => void;
};

/** Coordinates as the keyboard map announces them: 1-based, column then row. */
const cell = (pos: GridPos) => `${pos.x + 1}, ${pos.y + 1}`;

/** Compass word for the server's unit direction vector (x grows east, y grows south). */
export function compass(direction: GridPos): string {
  const ns = direction.y < 0 ? 'north' : direction.y > 0 ? 'south' : '';
  const ew = direction.x > 0 ? 'east' : direction.x < 0 ? 'west' : '';
  return ns && ew ? `${ns}-${ew}` : ns || ew || 'here';
}

const spellName = (spellId: string) =>
  spellId.replace(/^spell:/, '').replaceAll('-', ' ');

/**
 * Area aim as a list the keyboard can walk. A native radio group gives arrow-key selection and one
 * tab stop; the selected aim's affected units are previewed in a live region before Cast is pressed.
 * Cast sends the option's optionId as target {kind:'option', ref}; the server re-derives the cells.
 */
export function AreaAim({ areas, nameOf, onCast }: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = areas.find((area) => area.optionId === selectedId) ?? null;
  const labelOf = (area: AreaOption) =>
    `${spellName(area.spellId)} at ${cell(area.anchor)}, facing ${compass(area.direction)}; ${area.affected.length} affected`;
  const preview = selected
    ? selected.affected.length
      ? `${selected.affected.length} affected: ${selected.affected
          .map((unit) => `${nameOf(unit.id)} (${unit.relation})`)
          .join(', ')}.`
      : 'No units affected.'
    : 'Choose an aim to preview who it affects.';

  return (
    <fieldset className="area-aim">
      <legend>Area aim</legend>
      <div role="group" aria-label="Area aims">
        {areas.map((area) => (
          <label key={area.optionId} className="area-aim__option">
            <input
              type="radio"
              name="area-aim"
              value={area.optionId}
              checked={area.optionId === selectedId}
              onChange={() => setSelectedId(area.optionId)}
              onKeyDown={(event) => {
                if (event.key === 'Escape' && selected) {
                  event.preventDefault();
                  setSelectedId(null);
                }
              }}
            />{' '}
            {labelOf(area)}
          </label>
        ))}
      </div>
      <p aria-live="polite" aria-atomic="true">
        {preview}
      </p>
      <div role="group" aria-label="Area confirmation">
        <button
          type="button"
          disabled={!selected}
          onClick={() => selected && onCast(selected)}
        >
          Cast area
        </button>
        <button
          type="button"
          disabled={!selected}
          onClick={() => setSelectedId(null)}
        >
          Cancel area aim
        </button>
      </div>
    </fieldset>
  );
}
