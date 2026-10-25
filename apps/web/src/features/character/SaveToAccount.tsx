import { useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Character } from '@game/schema';
import { api } from '../../api';
import { useAuth } from '../../auth';
import {
  createCharacterBody,
  saveFailureFor,
  saveFailureMessage,
  type SaveFailure,
} from './saveCharacter';

interface SavedCharacter {
  id: string;
  revision: number;
  name: string;
  classId: string;
  speciesId: string;
  level: number;
}

type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved'; name: string }
  | { kind: 'failed'; failure: SaveFailure };

/** Offers to save a built character to the signed-in account so it can be bound at a table. */
export function SaveToAccount({ character }: { character: Character }) {
  const { account } = useAuth();
  const headingId = useId();
  const [state, setState] = useState<SaveState>({ kind: 'idle' });
  // A ref, not state, so a second click before the first response is ignored.
  const inFlight = useRef(false);

  if (!account) return null;

  async function save() {
    if (inFlight.current) return;
    inFlight.current = true;
    setState({ kind: 'saving' });
    const res = await api<SavedCharacter>(
      '/api/me/characters',
      createCharacterBody(character),
    );
    inFlight.current = false;
    if (res.ok) setState({ kind: 'saved', name: res.data.name });
    else setState({ kind: 'failed', failure: saveFailureFor(res.code) });
  }

  return (
    <section aria-labelledby={headingId}>
      <h2 id={headingId}>Save to my account</h2>
      {state.kind === 'saved' ? (
        <>
          <p role="status">
            {state.name} is saved to your account. You can bind them at a table
            from the lobby.
          </p>
          <p>
            <Link to="/rooms">Go to my games</Link>
          </p>
        </>
      ) : (
        <>
          <p>
            Saving keeps this character on your account, so you can bind it to a
            seat at any table you join.
          </p>
          <button type="button" onClick={() => void save()}>
            Save to my account
          </button>
          {state.kind === 'saving' && <p role="status">Saving…</p>}
          {state.kind === 'failed' && (
            <p role="alert">
              {saveFailureMessage(state.failure)}{' '}
              {state.failure === 'unauthenticated' && (
                <Link to="/login">Sign in</Link>
              )}
            </p>
          )}
        </>
      )}
    </section>
  );
}
