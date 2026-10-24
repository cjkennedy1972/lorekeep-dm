import type { Catalog } from '@game/rules-engine';
import type { Seat } from '@game/schema';

/** A character the signed-in account owns, as listed by GET /api/me/characters. Ids, not display strings. */
export interface OwnedCharacter {
  id: string;
  name: string;
  classId: string;
  speciesId: string;
  level: number;
  /** Sent back as expectedRevision so the server can reject a choice made against an older sheet. */
  revision: number;
}

export type BindFailure =
  | 'already-bound'
  | 'stale-revision'
  | 'not-seated'
  | 'account-inactive'
  | 'rate-limited'
  | 'rejected'
  | 'no-reply'
  | 'interrupted';

/** Maps a bind Error code to a failure. ACTION_REJECTED and codes the picker does not name fall back to 'rejected', so the copy never implies ownership. */
export function bindFailureFor(code: string): BindFailure {
  switch (code) {
    case 'ALREADY_BOUND':
      return 'already-bound';
    case 'STALE_REVISION':
      return 'stale-revision';
    case 'NOT_SEATED':
      return 'not-seated';
    case 'ACCOUNT_INACTIVE':
      return 'account-inactive';
    case 'RATE_LIMITED':
      return 'rate-limited';
    default:
      return 'rejected';
  }
}

const FAILURE_MESSAGE: Record<BindFailure, string> = {
  'already-bound':
    'This seat or character is already bound at this table. Choose another character.',
  'stale-revision':
    'That character changed since the list loaded. Reload your characters and choose again.',
  'not-seated':
    'Your seat is not active at this table. Rejoin the table, then try again.',
  'account-inactive':
    'This account is inactive, so characters cannot be bound to a seat.',
  'rate-limited': 'Too many bind attempts. Wait a moment, then try again.',
  rejected:
    'That character could not be bound. Reload your characters and choose again.',
  'no-reply':
    'The table did not confirm the bind. Check the connection, then try again.',
  interrupted:
    'Binding was interrupted by a connection change. Try again once the table has reconnected.',
};

export function bindFailureMessage(failure: BindFailure): string {
  return FAILURE_MESSAGE[failure];
}

/** Display name for a catalog id; falls back to the raw id when the catalog lacks it. */
export function catalogName(catalog: Catalog, id: string): string {
  return catalog.getAny(id)?.name ?? id;
}

/** Summary line for a character in the picker; never includes a sheet. */
export function characterLabel(c: OwnedCharacter, catalog: Catalog): string {
  return `${c.name}, ${catalogName(catalog, c.speciesId)} ${catalogName(catalog, c.classId)}, level ${c.level}`;
}

/** The picker is offered only for the local seat while that seat is current and not revoked. */
export function canOfferPicker(
  seats: Pick<Seat, 'seatId' | 'presence'>[],
  mySeatId: string | null,
  unseated: boolean,
): boolean {
  if (mySeatId === null || unseated) return false;
  const mine = seats.find((s) => s.seatId === mySeatId);
  return mine !== undefined && mine.presence !== 'revoked';
}
