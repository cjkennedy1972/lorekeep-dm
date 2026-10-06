import * as Switch from '@radix-ui/react-switch';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import type { DeviceSession, ExportJob } from '@game/schema';
import { usePrefs, type TextSize, type Theme } from '../a11y/prefs';
import { api, http, type Account } from '../api';
import { useAuth } from '../auth';
import { DeleteAccountDialog } from './DeleteAccountDialog';
import { Field } from './Field';

const when = (iso: string) => (
  <time dateTime={iso}>{new Date(iso).toLocaleString()}</time>
);

function Profile({ account }: { account: Account }) {
  const { setAccount } = useAuth();
  const [name, setName] = useState(account.displayName);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  async function save(e: FormEvent) {
    e.preventDefault();
    setMsg('');
    const r = await api<{ account: Account }>(
      '/api/me',
      { displayName: name },
      'PATCH',
    );
    if (!r.ok) return setError(r.message);
    setError('');
    setAccount(r.data.account);
    setMsg('Display name saved.');
  }
  return (
    <section aria-labelledby="profile-h">
      <h2 id="profile-h">Profile</h2>
      <form onSubmit={save} noValidate className="form">
        <Field
          id="display-name"
          label="Display name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          error={error}
          maxLength={80}
        />
        <div className="actions">
          <button type="submit">Save display name</button>
        </div>
        <p role="status">{msg}</p>
      </form>
    </section>
  );
}

function Password() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState('');
  async function save(e: FormEvent) {
    e.preventDefault();
    setMsg('');
    if (!current) return setErrors({ current: 'Enter your current password.' });
    if (next.length < 12)
      return setErrors({ next: 'Password must be at least 12 characters.' });
    const r = await api(
      '/api/me/password',
      { currentPassword: current, newPassword: next },
      'POST',
    );
    if (!r.ok) return setErrors({ current: r.message });
    setErrors({});
    setCurrent('');
    setNext('');
    setMsg('Password changed.');
  }
  return (
    <section aria-labelledby="password-h">
      <h2 id="password-h">Change password</h2>
      <form onSubmit={save} noValidate className="form">
        <Field
          id="current-password"
          label="Current password"
          type="password"
          autoComplete="current-password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          error={errors.current}
        />
        <Field
          id="new-password"
          label="New password"
          type="password"
          autoComplete="new-password"
          hint="At least 12 characters."
          value={next}
          onChange={(e) => setNext(e.target.value)}
          error={errors.next}
        />
        <div className="actions">
          <button type="submit">Change password</button>
        </div>
        <p role="status">{msg}</p>
      </form>
    </section>
  );
}

function Sessions() {
  const { setAccount } = useAuth();
  const navigate = useNavigate();
  const [list, setList] = useState<DeviceSession[] | null>(null);
  const [msg, setMsg] = useState('');
  const load = useCallback(async () => {
    const r = await api<{ sessions: DeviceSession[] }>('/api/me/sessions');
    if (r.ok) setList(r.data.sessions);
    else setMsg(r.message);
  }, []);
  useEffect(() => void load(), [load]);

  async function revoke(s: DeviceSession) {
    if (s.current) {
      await api('/api/logout', {});
      setAccount(null);
      return navigate('/login', { replace: true });
    }
    const r = await api(`/api/me/sessions/${s.id}`, undefined, 'DELETE');
    setMsg(r.ok ? `Signed out ${s.label}.` : r.message);
    await load();
  }
  async function revokeOthers() {
    const r = await api('/api/me/sessions/revoke-others', {});
    setMsg(r.ok ? 'Signed out all other devices.' : r.message);
    await load();
  }
  return (
    <section aria-labelledby="sessions-h">
      <h2 id="sessions-h">Devices signed in</h2>
      {list && (
        <ul className="sessions" aria-label="Signed-in devices">
          {list.map((s) => (
            <li key={s.id}>
              <span>
                {s.label}
                {s.current && ' (this device)'}
                <br />
                Last active {when(s.lastActiveAt)}
              </span>
              <button
                type="button"
                className="secondary"
                aria-label={`${s.current ? 'Sign out this device' : 'Sign out'}: ${s.label}, last active ${new Date(s.lastActiveAt).toLocaleString()}`}
                onClick={() => void revoke(s)}
              >
                {s.current ? 'Sign out this device' : 'Sign out'}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="actions">
        <button
          type="button"
          className="secondary"
          disabled={!list || list.length < 2}
          onClick={() => void revokeOthers()}
        >
          Sign out all other devices
        </button>
      </div>
      <p role="status">{msg}</p>
    </section>
  );
}

/** Poll interval while an export is pending; tests shorten it. */
export const exportPoll = { ms: 1000 };

function Export() {
  const [job, setJob] = useState<ExportJob | null | undefined>();
  const [error, setError] = useState('');
  const pending = job?.status === 'pending';
  useEffect(() => {
    let live = true;
    let t: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const r = await api<{ job: ExportJob | null }>('/api/me/export-job');
      if (!live) return;
      if (!r.ok) return setError(r.message);
      setJob(r.data.job);
      if (r.data.job?.status === 'pending') t = setTimeout(poll, exportPoll.ms);
    };
    void poll();
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [pending]);

  async function request() {
    setError('');
    const r = await api<{ job: ExportJob }>('/api/me/export', {});
    if (r.ok) setJob(r.data.job);
    else setError(r.message);
  }
  return (
    <section aria-labelledby="export-h">
      <h2 id="export-h">Export my data</h2>
      <p>
        Get an archive of your profile, characters, game snapshots, summaries
        and transcripts still within retention. It is ready within 24 hours.
      </p>
      <div className="actions">
        <button
          type="button"
          className="secondary"
          disabled={pending}
          onClick={() => void request()}
        >
          {job?.status === 'expired'
            ? 'Request a new export'
            : 'Export my data'}
        </button>
      </div>
      <p role="status" aria-live="polite">
        {error ||
          (job?.status === 'pending' && 'Preparing your export…') ||
          (job?.status === 'expired' &&
            'Your export has expired. Request a new one.') ||
          ''}
        {job?.status === 'ready' && (
          <>
            Your export is ready.{' '}
            <a href={`${http.base}${job.downloadUrl}`} download>
              Download your data
            </a>
            {job.expiresAt && <> (link expires {when(job.expiresAt)})</>}
          </>
        )}
      </p>
    </section>
  );
}

function Danger() {
  const [open, setOpen] = useState(false);
  return (
    <section aria-labelledby="delete-h">
      <h2 id="delete-h">Delete account</h2>
      <p>
        Deleting your account is permanent and cannot be undone. You will be
        asked for your password first.
      </p>
      <div className="actions">
        <button type="button" className="danger" onClick={() => setOpen(true)}>
          Delete my account…
        </button>
      </div>
      {open && <DeleteAccountDialog onCancel={() => setOpen(false)} />}
    </section>
  );
}

export function Settings() {
  const [prefs, set] = usePrefs();
  const { account } = useAuth();
  return (
    <>
      <h1>Settings</h1>
      {account && (
        <>
          <Profile account={account} />
          <Password />
          <Sessions />
          <Export />
          <Danger />
        </>
      )}
      <h2>Display</h2>
      <div className="field">
        <label htmlFor="text-size">Text size</label>
        <select
          id="text-size"
          value={prefs.textSize}
          onChange={(e) => set({ textSize: e.target.value as TextSize })}
        >
          <option value="normal">Normal</option>
          <option value="large">Large</option>
          <option value="xlarge">Extra large</option>
        </select>
      </div>
      <div className="field">
        <label htmlFor="theme">Theme</label>
        <select
          id="theme"
          value={prefs.theme}
          onChange={(e) => set({ theme: e.target.value as Theme })}
        >
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </div>
      <div className="field">
        <label htmlFor="dyslexia">Dyslexia-friendly font</label>
        <Switch.Root
          id="dyslexia"
          className="switch"
          checked={prefs.dyslexiaFont}
          onCheckedChange={(dyslexiaFont) => set({ dyslexiaFont })}
        >
          <Switch.Thumb className="switch-thumb" />
        </Switch.Root>
      </div>
      <div className="field">
        <label htmlFor="cvd">Colorblind-safe colors</label>
        <Switch.Root
          id="cvd"
          className="switch"
          checked={prefs.palette === 'cvd'}
          onCheckedChange={(on) => set({ palette: on ? 'cvd' : 'default' })}
        >
          <Switch.Thumb className="switch-thumb" />
        </Switch.Root>
      </div>
    </>
  );
}
