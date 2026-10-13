import { useEffect, useState, type FormEvent } from 'react';
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
  const [preview, setPreview] = useState<RoomInfo>();
  const [previewError, setPreviewError] = useState('');
  const content = useMatureOptOut();
  const checked = draft ?? content.optOut ?? false;

  useEffect(() => {
    if (!code) return;
    let live = true;
    void api<{ room: RoomInfo }>(
      `/api/invites/${encodeURIComponent(code)}`,
    ).then((r) => {
      if (!live) return;
      if (r.ok) setPreview(r.data.room);
      else setPreviewError(r.message);
    });
    return () => void (live = false);
  }, [code]);

  async function joinTable(e: FormEvent, invite: string) {
    e.preventDefault();
    setJoining(true);
    setError('');
    const r = await api<{ room: RoomInfo }>(
      `/api/invites/${encodeURIComponent(invite)}/join`,
      { matureOptOut: checked },
    );
    if (r.ok) return navigate(`/rooms/${r.data.room.id}`, { replace: true });
    setError(r.message);
    setJoining(false);
  }

  if (code) {
    const message = error || content.error;
    if (content.optOut === undefined || !preview)
      return (
        <>
          <h1>Join table</h1>
          {previewError || content.error ? (
            <p role="alert">
              {previewError || content.error}{' '}
              <Link to="/rooms">Back to My tables</Link>
            </p>
          ) : (
            <p role="status">Loading table settings…</p>
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
          <p>
            Table: <strong>{preview.name}</strong>
          </p>
          <p>
            Table setting:{' '}
            <strong>
              {preview.tierCap == null
                ? 'Mature (default)'
                : preview.tierCap === 'standard'
                  ? 'Standard'
                  : 'Family'}
            </strong>
          </p>
          <MatureOptOutField
            checked={checked}
            tierCap={preview.tierCap ?? null}
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
