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

  it('rejects an unauthored scene transition', async () => {
    const executor = createSceneCloseExecutor({
      sceneId: 'loc_redteam',
      nextSceneIds: ['loc_tavern'],
      allowSummary: async () => true,
    });

    await expect(
      executor({ summary: 'Leave.', nextSceneId: 'loc_forge' }),
    ).resolves.toMatchObject({
      ok: false,
      error: 'invalid-scene-transition',
    });
  });

  it('rejects a summary disallowed by table safety settings', async () => {
    const allowSummary = vi.fn(async () => false);
    const executor = createSceneCloseExecutor({
      sceneId: 'loc_redteam',
      nextSceneIds: ['loc_tavern'],
      allowSummary,
    });

    await expect(
      executor({ summary: 'Unsafe.', nextSceneId: 'loc_tavern' }),
    ).resolves.toMatchObject({
      ok: false,
      error: 'schema-violation',
    });
    expect(allowSummary).toHaveBeenCalledWith('Unsafe.');
  });

  it('emits a state-changing SceneClosed event for a valid proposal', async () => {
    const executor = createSceneCloseExecutor({
      sceneId: 'loc_redteam',
      nextSceneIds: ['loc_tavern'],
      allowSummary: async () => true,
    });

    await expect(
      executor({
        summary: 'Ayla leaves the crossroads.',
        nextSceneId: 'loc_tavern',
      }),
    ).resolves.toMatchObject({
      ok: true,
      output: {
        events: [
          {
            type: 'SceneClosed',
            sceneId: 'loc_redteam',
            nextSceneId: 'loc_tavern',
          },
        ],
      },
    });
  });
});
