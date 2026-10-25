import type { Character } from '@game/schema';

/** Why a save to the account failed, from POST /api/me/characters. */
export type SaveFailure =
  | 'invalid'
  | 'rate-limited'
  | 'account-inactive'
  | 'unauthenticated'
  | 'other'
  | 'uncertain';

/** Body for POST /api/me/characters. The server assigns the id, so the local id is dropped. */
export function createCharacterBody(character: Character) {
  const sheet: Partial<Character> = { ...character };
  delete sheet.id;
  return { character: sheet as Omit<Character, 'id'> };
}

/** Maps a failed save to a failure kind. ACCOUNT_INACTIVE is told apart from other 403s by its code. */
export function saveFailureFor(code: string): SaveFailure {
  switch (code) {
    case 'INVALID_CHARACTER':
      return 'invalid';
    case 'RATE_LIMITED':
      return 'rate-limited';
    case 'ACCOUNT_INACTIVE':
      return 'account-inactive';
    case 'UNAUTHENTICATED':
      return 'unauthenticated';
    default:
      return 'other';
  }
}

const SAVE_FAILURE_MESSAGE: Record<SaveFailure, string> = {
  invalid:
    'This character could not be saved because some details are not valid. Build a new character and try again.',
  'rate-limited': 'Too many saves right now. Wait a minute, then try again.',
  'account-inactive':
    'This account is inactive, so characters cannot be saved to it.',
  unauthenticated:
    'Your session has ended. Sign in again to save this character.',
  other:
    'The character could not be saved. Check your connection, then try again.',
  uncertain:
    'We may or may not have saved this character. Check your characters in the party lobby before trying again.',
};

export function saveFailureMessage(failure: SaveFailure): string {
  return SAVE_FAILURE_MESSAGE[failure];
}
