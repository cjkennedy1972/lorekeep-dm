import type { DMToolErrorCode } from '@game/schema';
export type ToolResult<T> =
  | { ok: true; value: T; events: string[]; summary: string }
  | { ok: false; error: DMToolErrorCode; hint: string };
export const fail = (
  error: DMToolErrorCode,
  hint: string,
): ToolResult<never> => ({ ok: false, error, hint });
export const ok = <T>(
  value: T,
  events: string[],
  summary: string,
): ToolResult<T> => ({
  ok: true,
  value,
  events,
  summary: summary.slice(0, 200),
});
