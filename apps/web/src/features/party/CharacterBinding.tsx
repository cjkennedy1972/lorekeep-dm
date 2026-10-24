import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import { api } from '../../api';
import { loadCharacterCatalog } from '../character/catalog';
import {
  bindFailureFor,
  bindFailureMessage,
  characterLabel,
  type BindFailure,
  type OwnedCharacter,
} from './bindCharacter';

const catalog = loadCharacterCatalog();

/** How long a bind may wait for its Error before the picker stops waiting and says so. */
export const BIND_REPLY_TIMEOUT_MS = 10_000;

export interface BindServerError {
  actionId: string;
  code: string;
  message: string;
}

interface Props {
  /** Whether the server has bound a character to this seat. */
  bound: boolean;
  /** Room client send; returns the wire actionId, or false when the socket is not open. */
  send: (type: string, payload: Record<string, unknown>) => string | false;
  /** Latest server Error; only the one matching this component's bind attempt is shown. */
  serverError: BindServerError | null;
  /** False while the socket is down; an in-flight bind can no longer get its reply. */
  connected: boolean;
  /** True while a resync is pending; the snapshot that answers it replaces the bind state. */
  resyncing: boolean;
  replyTimeoutMs?: number;
}

export function CharacterBinding({
  bound,
  send,
  serverError,
  connected,
  resyncing,
  replyTimeoutMs = BIND_REPLY_TIMEOUT_MS,
}: Props) {
  const selectId = useId();
  const [characters, setCharacters] = useState<OwnedCharacter[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const [failure, setFailure] = useState<BindFailure | null>(null);
  const [offline, setOffline] = useState(false);

  const load = useCallback(async () => {
    setLoadError(null);
    const res = await api<{ characters: OwnedCharacter[] }>(
      '/api/me/characters',
    );
    if (!res.ok) {
      setLoadError('Your characters could not be loaded.');
      return;
    }
    setCharacters(res.data.characters);
    setSelectedId((current) =>
      res.data.characters.some((c) => c.id === current)
        ? current
        : (res.data.characters[0]?.id ?? ''),
    );
  }, []);

  useEffect(() => {
    if (!bound) void load();
  }, [bound, load]);

  useEffect(() => {
    if (bound) {
      setPending(null);
      setFailure(null);
    }
  }, [bound]);

  useEffect(() => {
    if (!pending || !serverError || serverError.actionId !== pending) return;
    setPending(null);
    setFailure(bindFailureFor(serverError.code));
  }, [pending, serverError]);

  // Terminal outcomes without an Error: no reply in time, a dropped socket, or a resync that replaces the state.
  // A bind that already landed (bound) wins over any of these, even when it arrives in the same update as a resync.
  useEffect(() => {
    if (!pending || bound) return;
    if (!connected || resyncing) {
      setPending(null);
      setFailure('interrupted');
      return;
    }
    const timer = window.setTimeout(() => {
      setPending(null);
      setFailure('no-reply');
    }, replyTimeoutMs);
    return () => window.clearTimeout(timer);
  }, [pending, bound, connected, resyncing, replyTimeoutMs]);

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const chosen = characters?.find((c) => c.id === selectedId);
    if (!chosen) return;
    const actionId = send('BindCharacter', {
      characterId: chosen.id,
      expectedRevision: chosen.revision,
    });
    if (actionId === false) {
      setOffline(true);
      return;
    }
    setOffline(false);
    setFailure(null);
    setPending(actionId);
  };

  if (bound)
    return (
      <section aria-labelledby={`${selectId}-heading`}>
        <h3 id={`${selectId}-heading`}>Your character</h3>
        <p role="status">
          Your character is bound. Your seat is ready to play.
        </p>
      </section>
    );

  return (
    <section aria-labelledby={`${selectId}-heading`}>
      <h3 id={`${selectId}-heading`}>Bind a character to play</h3>
      <p>Party play waits until every seat has a character bound.</p>

      {loadError ? (
        <p role="alert">
          {loadError}{' '}
          <button type="button" onClick={() => void load()}>
            Try again
          </button>
        </p>
      ) : characters === null ? (
        <p role="status">Loading your characters…</p>
      ) : characters.length === 0 ? (
        <p>
          You have no characters on this account yet, so there is nothing to
          bind.
        </p>
      ) : (
        <form onSubmit={onSubmit}>
          <label htmlFor={selectId}>Your character</label>{' '}
          <select
            id={selectId}
            value={selectedId}
            onChange={(e) => setSelectedId(e.target.value)}
            disabled={pending !== null}
          >
            {characters.map((c) => (
              <option key={c.id} value={c.id}>
                {characterLabel(c, catalog)}
              </option>
            ))}
          </select>{' '}
          <button type="submit" disabled={pending !== null || !selectedId}>
            Bind character
          </button>
        </form>
      )}

      {pending && <p role="status">Binding your character…</p>}
      {offline && (
        <p role="alert">
          Not connected to the table. Reconnect, then try binding again.
        </p>
      )}
      {failure && (
        <p role="alert">
          {bindFailureMessage(failure)}{' '}
          {(failure === 'stale-revision' || failure === 'rejected') && (
            <button
              type="button"
              onClick={() => {
                setFailure(null);
                void load();
              }}
            >
              Reload characters
            </button>
          )}
        </p>
      )}
    </section>
  );
}
