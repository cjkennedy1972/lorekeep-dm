import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { Field } from './Field';

export const DELETE_PHRASE = 'DELETE MY ACCOUNT';

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), a[href]';

/** Modal confirm step: password + exact phrase. Traps Tab, Escape cancels, focus returns to the opener. */
export function DeleteAccountDialog({ onCancel }: { onCancel: () => void }) {
  const navigate = useNavigate();
  const { setAccount } = useAuth();
  const box = useRef<HTMLDivElement>(null);
  const [password, setPassword] = useState('');
  const [phrase, setPhrase] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    box.current?.querySelector<HTMLElement>('input')?.focus();
    return () => opener?.focus();
  }, []);

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') return onCancel();
    if (e.key !== 'Tab') return;
    const items = [...box.current!.querySelectorAll<HTMLElement>(FOCUSABLE)];
    const first = items[0]!;
    const last = items[items.length - 1]!;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    const r = await api(
      '/api/me',
      { password, confirmation: phrase },
      'DELETE',
    );
    setBusy(false);
    if (!r.ok) {
      setPassword('');
      setError(r.message);
      return box.current?.querySelector<HTMLElement>('input')?.focus();
    }
    setAccount(null);
    navigate('/', { replace: true });
  }

  return (
    <div className="modal-backdrop">
      <div
        ref={box}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-title"
        aria-describedby="delete-warning"
        onKeyDown={onKeyDown}
      >
        <h2 id="delete-title">Delete your account?</h2>
        <div id="delete-warning">
          <p>
            <strong>This cannot be undone.</strong> You will be signed out
            everywhere and your profile is hidden immediately. Your personal
            data is purged from live systems within 30 days, and from backups on
            their normal cycle of up to 30 days.
          </p>
          <p>
            Tables you host pass to a connected player, or are archived if no
            one is connected. In other tables your character becomes an NPC and
            your name is removed from the transcript.
          </p>
        </div>
        <form onSubmit={submit} noValidate className="form">
          {error && (
            <p id="delete-error" role="alert" className="form-error">
              {error}
            </p>
          )}
          <Field
            id="delete-password"
            label="Your password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            describedBy={error ? 'delete-error' : undefined}
            required
          />
          <Field
            id="delete-phrase"
            label={`Type ${DELETE_PHRASE} to confirm`}
            autoComplete="off"
            value={phrase}
            onChange={(e) => setPhrase(e.target.value)}
            required
          />
          <div className="actions">
            <button type="button" className="secondary" onClick={onCancel}>
              Keep my account
            </button>
            <button
              type="submit"
              className="danger"
              disabled={busy || !password || phrase !== DELETE_PHRASE}
            >
              Permanently delete account
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
