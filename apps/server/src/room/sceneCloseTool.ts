import type { DmToolContext, ToolExecution } from '../dm/orchestrator.js';

// ponytail: DM-proposed closes are rejected unconditionally; scene closes come only from engine-internal paths.
export function createSceneCloseExecutor(_input: {
  sceneId?: string;
  nextSceneIds: readonly string[];
  allowSummary: (summary: string) => Promise<boolean>;
}): NonNullable<DmToolContext['closeScene']> {
  return async (): Promise<ToolExecution> => ({
    ok: false,
    error: 'unknown-tool',
    hint: 'The DM cannot close scenes; continue the current scene.',
  });
}
