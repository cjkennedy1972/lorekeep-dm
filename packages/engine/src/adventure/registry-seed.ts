import seed from '../../adventures/01/registry-seed.json' with { type: 'json' };
export type Adventure01RegistryDiff =
  | {
      kind: 'npc' | 'location';
      id: string;
      after: Record<string, unknown>;
      aliases: string[];
    }
  | { kind: 'quest' | 'flag'; id: string; after: Record<string, unknown> };

/** Schema-valid, normalized seed diffs for the Adventure #1 registry. */
export function adventure01RegistrySeed(): Adventure01RegistryDiff[] {
  return [
    ...seed.npcs.map((npc) => ({
      kind: 'npc' as const,
      id: npc.id,
      after: npc,
      aliases: [],
    })),
    ...seed.locations.map((location) => ({
      kind: 'location' as const,
      id: location.id,
      after: location,
      aliases: [],
    })),
    ...seed.quests.map((quest) => ({
      kind: 'quest' as const,
      id: quest.id,
      after: quest,
    })),
    ...seed.flags.map((flag) => ({
      kind: 'flag' as const,
      id: flag.id,
      after: flag,
    })),
  ];
}
