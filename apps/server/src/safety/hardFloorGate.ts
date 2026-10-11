import { checkHardFloor } from './hardFloor.js';

export const HARD_FLOOR_LOG_RETENTION_MS = 30 * 86_400_000;

interface WarnLog {
  warn: (obj: object, msg: string) => void;
}

/** Returns true when text must be rejected. Logs structured metadata only (account id for abuse correlation), never the text. */
export function hardFloorBlocked(
  text: string,
  surface: string,
  log: WarnLog,
  accountId?: string,
): boolean {
  const result = checkHardFloor(text);
  if (!result.blocked) return false;
  log.warn(
    {
      event: 'hard_floor_block',
      surface,
      ...(accountId ? { accountId } : {}),
      rule: result.rule,
      version: result.version,
      expiresAt: new Date(
        Date.now() + HARD_FLOOR_LOG_RETENTION_MS,
      ).toISOString(),
    },
    'hard floor rejected input',
  );
  return true;
}
