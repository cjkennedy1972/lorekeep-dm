import type { Adventure } from '@game/schema';

/** Selects an authored successor; invalid DM branch suggestions never change state. */
export function nextSceneAfterClose(
  adventure: Adventure,
  sceneId: string,
  requestedNextSceneId?: string,
): { sceneId: string; completed: false } | { completed: true } | undefined {
  const scene = adventure.scenes.find((candidate) => candidate.id === sceneId);
  if (!scene) return undefined;
  if (scene.nextSceneIds.length === 0) return { completed: true };
  const nextSceneId = requestedNextSceneId
    ? scene.nextSceneIds.includes(requestedNextSceneId)
      ? requestedNextSceneId
      : undefined
    : scene.nextSceneIds[0];
  return nextSceneId ? { sceneId: nextSceneId, completed: false } : undefined;
}
