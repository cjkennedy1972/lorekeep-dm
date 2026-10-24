/** A character the signed-in account owns, as listed for the binding picker. */
export interface OwnedCharacter {
  id: string;
  name: string;
  species: string;
  className: string;
  level: number;
  /** Sent back as expectedRevision so the server can reject a choice made against an older sheet. */
  revision: number;
}

export type BindFailure =
  | 'not-owner'
  | 'already-bound'
  | 'stale-revision'
  | 'rejected';

/** Maps an Error code from the server to a binding failure. Unknown codes fall back to 'rejected'. */
export function bindFailureFor(code: string): BindFailure {
  switch (code) {
    case 'NOT_OWNER':
      return 'not-owner';
    case 'ALREADY_BOUND':
      return 'already-bound';
    case 'STALE_REVISION':
      return 'stale-revision';
    default:
      return 'rejected';
  }
}

const FAILURE_MESSAGE: Record<BindFailure, string> = {
  'not-owner':
    'That character is not yours. Choose one of your own characters.',
  'already-bound': 'This seat already has a character bound.',
  'stale-revision':
    'That character changed since the list loaded. Reload your characters and choose again.',
  rejected:
    'The character could not be bound. It may already be in use at this table. Try another.',
};

export function bindFailureMessage(failure: BindFailure): string {
  return FAILURE_MESSAGE[failure];
}

/** Summary line for a character in the picker; never includes a sheet. */
export function characterLabel(c: OwnedCharacter): string {
  return `${c.name}, ${c.species} ${c.className}, level ${c.level}`;
}
