import type { DmToolContext, ToolExecution } from '../dm/orchestrator.js';

export function createSceneCloseExecutor(input: {
  sceneId?: string;
  nextSceneIds: readonly string[];
  allowSummary: (summary: string) => Promise<boolean>;
}): NonNullable<DmToolContext['closeScene']> {
  return async ({ summary, nextSceneId }): Promise<ToolExecution> => {
    if (!input.sceneId)
      return {
        ok: false,
        error: 'unknown-tool',
        hint: 'Scene closing is unavailable outside an active solo adventure.',
      };
    if (nextSceneId && !input.nextSceneIds.includes(nextSceneId))
      return {
        ok: false,
        error: 'invalid-scene-transition',
        hint: 'Choose one of the authored next scenes listed in the context, or omit nextSceneId.',
      };
    if (!(await input.allowSummary(summary)))
      return {
        ok: false,
        error: 'schema-violation',
        hint: 'The scene summary was rejected by the table safety settings. Use a safer summary.',
      };
    const event = {
      type: 'SceneClosed',
      sceneId: input.sceneId,
      summary,
      ...(nextSceneId ? { nextSceneId } : {}),
    };
    return {
      ok: true,
      summary: 'The current scene was closed.',
      events: [],
      output: { events: [event] },
    };
  };
}
