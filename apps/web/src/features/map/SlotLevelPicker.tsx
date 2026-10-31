type Props = {
  levels: number[];
  value: number;
  onChange: (level: number) => void;
};

/** Which spell slot a cast spends. Only the levels the caster can still pay for are offered. */
export function SlotLevelPicker({ levels, value, onChange }: Props) {
  return (
    <label className="slot-level-picker">
      Spell slot{' '}
      <select
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      >
        {levels.map((level) => (
          <option key={level} value={level}>
            {level === 0 ? 'Cantrip (no slot)' : `Level ${level} slot`}
          </option>
        ))}
      </select>
    </label>
  );
}
