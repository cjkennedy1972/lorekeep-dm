import { useEffect, useState } from 'react';
import { api } from '../api';

// DRAFT copy per ADR-016 (mature default-on); product/legal owner review required before publication.
const HINT =
  'Mature content is on by default at this table. It can include graphic violence, dark themes, strong language, and innuendo. Explicit sexual content is never included. Tick the box to opt out; the table then stays at standard content from the next scene. You can change this here at any time.';

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
  disabled,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (optOut: boolean) => void;
}) {
  return (
    <fieldset className="field">
      <legend>Mature content</legend>
      <p id="mature-hint">{HINT}</p>
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
