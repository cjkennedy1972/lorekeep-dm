import { describe, expect, it, vi } from 'vitest';
import { createSceneCloseExecutor } from '../../src/room/sceneCloseTool.js';

describe('production scene-close authorization', () => {
  it('rejects closing a scene outside an active adventure', async () => {
    const executor = createSceneCloseExecutor({
      sceneId: undefined,
      nextSceneIds: [],
      allowSummary: async () => true,
    });

    await expect(
      executor({ summary: 'Leave.', nextSceneId: 'loc_tavern' }),
    ).resolves.toMatchObject({
      ok: false,
      error: 'unknown-tool',
    });
  });

  it('rejects a DM-proposed close even for a valid authored transition', async () => {
    const allowSummary = vi.fn(async () => true);
    const executor = createSceneCloseExecutor({
      sceneId: 'loc_redteam',
      nextSceneIds: ['loc_tavern'],
      allowSummary,
    });

    await expect(
      executor({
        summary: 'Ayla leaves the crossroads.',
        nextSceneId: 'loc_tavern',
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: 'unknown-tool',
    });
    expect(allowSummary).not.toHaveBeenCalled();
  });
});
