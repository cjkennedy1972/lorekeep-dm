import { useId, useLayoutEffect, useRef, useState } from 'react';
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

/** One row of GET /api/me/characters. */
type OwnedCharacter = SavedCharacter;

type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved'; name: string }
  | { kind: 'failed'; failure: SaveFailure };

type CheckState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'absent'; name: string }
  | { kind: 'error' };

/** A listed character is this one when its name, class, species and level all match the sheet. */
function isThisCharacter(listed: OwnedCharacter, character: Character) {
  return (
    listed.name === character.name &&
    listed.classId === character.classId &&
    listed.speciesId === character.speciesId &&
    listed.level === character.level
  );
}

/** Offers to save a built character to the signed-in account so it can be bound at a table. */
export function SaveToAccount({ character }: { character: Character }) {
  const { account } = useAuth();
  const headingId = useId();
  const [state, setState] = useState<SaveState>({ kind: 'idle' });
  const [check, setCheck] = useState<CheckState>({ kind: 'idle' });
  // A ref, not state, so a second click before the first response is ignored.
  const inFlight = useRef(false);
  const alertRef = useRef<HTMLParagraphElement>(null);
  const checkNoteRef = useRef<HTMLParagraphElement>(null);
  const uncertain = state.kind === 'failed' && state.failure === 'uncertain';
  const checking = check.kind === 'checking';

  // Focus the uncertain alert in the commit that shows it, so the next Tab reaches "Check now"
  // before the explicit button and no frame or passive effect can lose the focus.
  useLayoutEffect(() => {
    if (uncertain) alertRef.current?.focus();
  }, [uncertain]);

  // The check button leaves the DOM once "absent" restores the plain save button, so move focus to the note.
  useLayoutEffect(() => {
    if (check.kind === 'absent') checkNoteRef.current?.focus();
  }, [check]);

  if (!account) return null;

  async function save() {
    if (inFlight.current) return;
    inFlight.current = true;
    setCheck({ kind: 'idle' });
    setState({ kind: 'saving' });
    try {
      const res = await api<SavedCharacter>(
        '/api/me/characters',
        createCharacterBody(character),
      );
      if (res.ok) setState({ kind: 'saved', name: res.data.name });
      // Status 0 means no HTTP response arrived, so the server may have created the character.
      else
        setState({
          kind: 'failed',
          failure: res.status === 0 ? 'uncertain' : saveFailureFor(res.code),
        });
    } catch {
      setState({ kind: 'failed', failure: 'uncertain' });
    } finally {
      inFlight.current = false;
    }
  }

  // Reads the account's own list; never posts. A match confirms the save; no match makes a plain retry safe.
  async function checkNow() {
    setCheck({ kind: 'checking' });
    try {
      const res = await api<{ characters: OwnedCharacter[] }>(
        '/api/me/characters',
      );
      if (!res.ok) {
        setCheck({ kind: 'error' });
        return;
      }
      if (
        res.data.characters.some((listed) => isThisCharacter(listed, character))
      ) {
        setCheck({ kind: 'idle' });
        setState({ kind: 'saved', name: character.name });
      } else {
        setState({ kind: 'idle' });
        setCheck({ kind: 'absent', name: character.name });
      }
    } catch {
      setCheck({ kind: 'error' });
    }
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
          {uncertain ? (
            <>
              <p role="alert" tabIndex={-1} ref={alertRef}>
                {saveFailureMessage('uncertain')}
              </p>
              <div className="action-row">
                <button
                  type="button"
                  disabled={checking}
                  onClick={() => void checkNow()}
                >
                  Check now
                </button>
                <button
                  type="button"
                  disabled={checking}
                  onClick={() => void save()}
                >
                  Save again anyway
                </button>
              </div>
              <p className="field-hint">
                Saving again may create a second character if the first save
                went through.
              </p>
            </>
          ) : (
            <div className="action-row">
              <button type="button" onClick={() => void save()}>
                Save to my account
              </button>
            </div>
          )}
          {state.kind === 'saving' && <p role="status">Saving…</p>}
          {state.kind === 'failed' && !uncertain && (
            <p role="alert">
              {saveFailureMessage(state.failure)}{' '}
              {state.failure === 'unauthenticated' && (
                <Link to="/login">Sign in</Link>
              )}
            </p>
          )}
          {checking && <p role="status">Checking your characters…</p>}
          {check.kind === 'absent' && (
            <p role="status" tabIndex={-1} ref={checkNoteRef}>
              We could not find {check.name} on your account, so this save did
              not go through. Saving again will not create a duplicate.
            </p>
          )}
          {check.kind === 'error' && (
            <p role="status">
              Could not check your characters. Try Check now again, or save
              again anyway.
            </p>
          )}
        </>
      )}
    </section>
  );
}
