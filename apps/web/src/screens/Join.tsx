import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, type RoomInfo } from '../api';
import type { OwnedCharacter } from '../features/party/bindCharacter';
import { LateJoinCharacterField } from '../features/party/LateJoinCharacterField';
import { MatureOptOutField, useMatureOptOut } from './MatureOptOut';

export function Join() {
  const { code } = useParams();
  const navigate = useNavigate();
  const [typed, setTyped] = useState('');
  const [error, setError] = useState('');
  const [draft, setDraft] = useState<boolean | null>(null);
  const [joining, setJoining] = useState(false);
  const [preview, setPreview] = useState<RoomInfo | undefined>();
  const [previewError, setPreviewError] = useState('');
  const [onboarding, setOnboarding] = useState<{
    settings?: {
      contentTier?: string;
      hostTierCap?: string | null;
      lines?: string[];
      veils?: string[];
    };
  }>();
  const [requestId, setRequestId] = useState('');
  const [recap, setRecap] = useState<{ text?: string; failed?: boolean }>();
  const [withdrawn, setWithdrawn] = useState(false);
  // The request whose recap may still be shown; a withdraw clears it so a late recap response is dropped.
  const liveRequestRef = useRef('');
  const content = useMatureOptOut();
  const checked = draft ?? content.optOut ?? false;
  const [owned, setOwned] = useState<OwnedCharacter[] | null>(null);
  const [ownedError, setOwnedError] = useState('');
  const [characterId, setCharacterId] = useState('');
  const [pendingMessage, setPendingMessage] = useState('');
  // The selection of a request still waiting on the host. A retry with the same character reuses its actionId, so the server returns the prior result.
  const attemptRef = useRef<{ characterId: string; actionId: string } | null>(
    null,
  );
  const pendingRef = useRef<HTMLParagraphElement>(null);

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

  const loadCharacters = useCallback(async () => {
    setOwnedError('');
    const r = await api<{ characters: OwnedCharacter[] }>('/api/me/characters');
    if (!r.ok) {
      setOwnedError('Your characters could not be loaded.');
      return;
    }
    setOwned(r.data.characters);
    setCharacterId((current) =>
      r.data.characters.some((c) => c.id === current)
        ? current
        : (r.data.characters[0]?.id ?? ''),
    );
  }, []);

  useEffect(() => {
    if (code) void loadCharacters();
  }, [code, loadCharacters]);

  useEffect(() => {
    if (pendingMessage) pendingRef.current?.focus();
  }, [pendingMessage]);

  async function loadRecap(id: string) {
    const r = await api<{ recap?: string }>(`/api/late-join/${id}/recap`);
    if (liveRequestRef.current !== id) return;
    setRecap(
      r.ok && typeof r.data.recap === 'string'
        ? { text: r.data.recap }
        : { failed: true },
    );
  }

  async function withdraw() {
    const r = await api(`/api/late-join/${requestId}/cancel`, {
      requestId,
      actionId: crypto.randomUUID(),
    });
    if (!r.ok) {
      setError('Your request could not be withdrawn. Try again.');
      return;
    }
    attemptRef.current = null;
    liveRequestRef.current = '';
    setRequestId('');
    setRecap(undefined);
    setOnboarding(undefined);
    setPendingMessage('');
    setWithdrawn(true);
  }

  async function joinTable(e: FormEvent, invite: string) {
    e.preventDefault();
    const chosen = owned?.find((c) => c.id === characterId);
    const selection = chosen
      ? {
          characterId: chosen.id,
          expectedRevision: chosen.revision,
          actionId:
            attemptRef.current?.characterId === chosen.id
              ? attemptRef.current.actionId
              : crypto.randomUUID(),
        }
      : undefined;
    setJoining(true);
    setError('');
    setWithdrawn(false);
    const r = await api<{ room: RoomInfo }>(
      `/api/invites/${encodeURIComponent(invite)}/join`,
      { matureOptOut: checked, ...selection },
    );
    if (r.ok) return navigate(`/rooms/${r.data.room.id}`, { replace: true });
    if (r.code === 'LATE_JOIN_PENDING') {
      attemptRef.current = selection ?? null;
      setOnboarding(r.data as typeof onboarding);
      const id = (r.data as { requestId?: unknown }).requestId;
      if (typeof id === 'string') {
        liveRequestRef.current = id;
        setRequestId(id);
        void loadRecap(id);
      }
      setPendingMessage(r.message);
      setJoining(false);
      return;
    }
    attemptRef.current = null;
    if (
      r.code === 'INVALID_CHARACTER' ||
      r.code === 'CHARACTER_CHANGED' ||
      r.code === 'CHARACTER_UNAVAILABLE'
    )
      void loadCharacters();
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
          <LateJoinCharacterField
            characters={owned}
            loadError={ownedError}
            selectedId={characterId}
            disabled={joining || pendingMessage !== ''}
            onChange={setCharacterId}
            onRetry={() => void loadCharacters()}
          />
          <MatureOptOutField
            checked={checked}
            tierCap={preview.tierCap ?? null}
            disabled={joining}
            onChange={(v) => setDraft(v)}
          />
          {onboarding && (
            <section aria-label="Table onboarding">
              <h2>Table onboarding</h2>
              {onboarding.settings && (
                <p>Content setting: {onboarding.settings.contentTier}</p>
              )}
              {onboarding.settings?.lines?.length ? (
                <p>Lines: {onboarding.settings.lines.join(', ')}</p>
              ) : null}
              {onboarding.settings?.veils?.length ? (
                <p>Veils: {onboarding.settings.veils.join(', ')}</p>
              ) : null}
            </section>
          )}
          {requestId && (
            <section aria-label="Previously on">
              <h2>Previously on…</h2>
              <div aria-live="polite">
                {recap === undefined ? (
                  <p>Loading recap…</p>
                ) : recap.failed ? (
                  <p>
                    The recap is not available right now. You can keep waiting
                    or withdraw.
                  </p>
                ) : (
                  <p>{recap.text}</p>
                )}
              </div>
              <button type="button" onClick={() => void withdraw()}>
                Withdraw request
              </button>
            </section>
          )}
          {withdrawn && <p role="status">Your join request was withdrawn.</p>}
          {pendingMessage && (
            <p role="alert" tabIndex={-1} ref={pendingRef}>
              {pendingMessage} <Link to="/rooms">Back to My tables</Link>
            </p>
          )}
          {message && (
            <p role="alert">
              {message} <Link to="/rooms">Back to My tables</Link>
            </p>
          )}
          <div className="actions">
            <button
              type="submit"
              disabled={joining || (owned === null && ownedError === '')}
            >
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
