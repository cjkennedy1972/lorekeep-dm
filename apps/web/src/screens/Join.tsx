import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, type RoomInfo } from '../api';

export function Join() {
  const { code } = useParams();
  const navigate = useNavigate();
  const [typed, setTyped] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!code) return;
    let live = true;
    void api<{ room: RoomInfo }>(
      `/api/invites/${encodeURIComponent(code)}/join`,
      {},
    ).then((r) => {
      if (!live) return;
      if (r.ok) navigate(`/rooms/${r.data.room.id}`, { replace: true });
      else setError(r.message);
    });
    return () => void (live = false);
  }, [code, navigate]);

  if (code)
    return (
      <>
        <h1>Joining table</h1>
        {error ? (
          <p role="alert">
            {error} <Link to="/rooms">Back to My tables</Link>
          </p>
        ) : (
          <p role="status">Joining the table…</p>
        )}
      </>
    );

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
