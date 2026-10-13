import { useEffect, useState } from 'react';
import { api } from '../api';

// Owner-approved ADR-016 disclosure, with the active cap reflected in the opt-out field.
const HINT =
  'Mature is on by default. It can include graphic violence, dark themes, strong language, and innuendo or allusion. Opting out keeps your personal content at Standard; other players’ preferences do not change. Explicit sexual content is out of scope, and the hard safety floor is fixed.';

/** The signed-in player's mature-content opt-out, loaded from /api/me and saved on change. */
export function useMatureOptOut() {
  const [optOut, setOptOut] = useState<boolean | undefined>();
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    void api<{ account: { matureOptOut: boolean } }>('/api/me').then((r) => {
      if (!live) return;
      if (r.ok) setOptOut(r.data.account.matureOptOut);
      else setError(r.message);
    });
    return () => void (live = false);
  }, []);
  async function save(next: boolean): Promise<boolean> {
    const r = await api(
      '/api/me/content-settings',
      { matureOptOut: next },
      'PATCH',
    );
    if (!r.ok) {
      setError(r.message);
      return false;
    }
    setError('');
    setOptOut(next);
    return true;
  }
  return { optOut, error, save };
}

export function MatureOptOutField({
  checked,
  tierCap = null,
  disabled,
  onChange,
}: {
  checked: boolean;
  tierCap?: 'family' | 'standard' | null;
  disabled?: boolean;
  onChange: (optOut: boolean) => void;
}) {
  return (
    <fieldset className="field">
      <legend>Mature content</legend>
      <p id="mature-hint">
        {tierCap === null
          ? HINT
          : `The ${tierCap === 'standard' ? 'Standard' : 'Family'} cap is in effect; Mature-tier content is unavailable under this cap. Your personal Mature opt-out preference is saved separately and remains in effect if the table cap later changes. Explicit sexual content is out of scope, and the hard safety floor is fixed.`}
      </p>
      <label>
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          aria-describedby="mature-hint"
          onChange={(e) => onChange(e.target.checked)}
        />{' '}
        Opt out of mature content
      </label>
    </fieldset>
  );
}
