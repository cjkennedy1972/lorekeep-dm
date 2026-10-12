import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, type RoomInfo } from '../api';
import { MatureOptOutField, useMatureOptOut } from './MatureOptOut';

export function Join() {
  const { code } = useParams();
  const navigate = useNavigate();
  const [typed, setTyped] = useState('');
  const [error, setError] = useState('');
  const [draft, setDraft] = useState<boolean | null>(null);
  const [joining, setJoining] = useState(false);
  const content = useMatureOptOut();
  const checked = draft ?? content.optOut ?? false;

  async function joinTable(e: FormEvent, invite: string) {
    e.preventDefault();
    setJoining(true);
    setError('');
    if (!(await content.save(checked))) return setJoining(false);
    const r = await api<{ room: RoomInfo }>(
      `/api/invites/${encodeURIComponent(invite)}/join`,
      {},
    );
    if (r.ok) return navigate(`/rooms/${r.data.room.id}`, { replace: true });
    setError(r.message);
    setJoining(false);
  }

  if (code) {
    const message = error || content.error;
    if (content.optOut === undefined)
      return (
        <>
          <h1>Join table</h1>
          {content.error ? (
            <p role="alert">
              {content.error} <Link to="/rooms">Back to My tables</Link>
            </p>
          ) : (
            <p role="status">Loading the table…</p>
          )}
        </>
      );
    return (
      <>
        <h1>Join table</h1>
        <form
          onSubmit={(e) => void joinTable(e, code)}
          noValidate
          className="form"
        >
          <MatureOptOutField
            checked={checked}
            disabled={joining}
            onChange={(v) => setDraft(v)}
          />
          {message && (
            <p role="alert">
              {message} <Link to="/rooms">Back to My tables</Link>
            </p>
          )}
          <div className="actions">
            <button type="submit" disabled={joining}>
              Join table
            </button>
          </div>
        </form>
      </>
    );
  }

  function go(e: FormEvent) {
    e.preventDefault();
    const c = typed.trim();
    if (!c) return setError('Enter the invite code.');
    navigate(`/join/${encodeURIComponent(c)}`);
  }
  return (
    <>
      <h1>Join a table</h1>
      <form onSubmit={go} noValidate className="form">
        <div className="field">
          <label htmlFor="invite-code">Invite code</label>
          <input
            id="invite-code"
            value={typed}
            autoComplete="off"
            autoCapitalize="characters"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? 'invite-code-error' : undefined}
            onChange={(e) => setTyped(e.target.value)}
          />
          {error && (
            <p id="invite-code-error" className="field-error" role="alert">
              {error}
            </p>
          )}
        </div>
        <button type="submit">Join</button>
      </form>
    </>
  );
}
