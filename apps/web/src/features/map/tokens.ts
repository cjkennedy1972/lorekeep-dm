import type { CombatState } from '@game/schema';

/** A stable, accessible marker for a team; distinct teams never depend on color. */
export interface TeamMarker {
  readonly shape:
    | 'circle'
    | 'square'
    | 'triangle'
    | 'diamond'
    | 'hexagon'
    | 'star';
  readonly letter: string;
}

export interface TokenPresentation {
  readonly name?: string;
  readonly team?: string;
  readonly maxHp?: number;
  readonly conditions?: readonly string[];
}

/** Serializable headless drawing instruction for one combatant. */
export interface TokenDrawCommand {
  readonly type: 'token';
  readonly entityId: string;
  readonly name: string;
  readonly x: number;
  readonly y: number;
  readonly footprint: number;
  readonly team: string;
  readonly teamMarker: TeamMarker;
  readonly hpLabel: string;
  readonly conditions: readonly {
    readonly icon: string;
    readonly label: string;
  }[];
  readonly active: boolean;
}

const MARKER_SHAPES: readonly TeamMarker['shape'][] = [
  'circle',
  'square',
  'triangle',
  'diamond',
  'hexagon',
  'star',
];
const CONDITION_ICONS: Readonly<Record<string, string>> = {
  blinded: '◉',
  charmed: '♡',
  deafened: '◖',
  frightened: '!',
  grappled: '⌁',
  incapacitated: '⊘',
  invisible: '◌',
  paralyzed: 'Ⅱ',
  petrified: '◆',
  poisoned: '☠',
  prone: '⌄',
  restrained: '⛓',
  stunned: '✦',
  unconscious: 'Z',
  exhaustion: '↓',
};

function markerFor(team: string, teamIndex: number): TeamMarker {
  return {
    shape: MARKER_SHAPES[teamIndex % MARKER_SHAPES.length]!,
    letter: team.slice(0, 1).toUpperCase() || '?',
  };
}

function hpLabel(kind: string, hp: number, maxHp: number): string {
  if (kind === 'character') return `HP ${hp}/${maxHp}`;
  return hp <= maxHp / 2 ? 'bloodied' : 'healthy';
}

/**
 * Creates one deterministic token instruction per combatant. Presentation data is
 * optional because the M1 combat schema stores only mechanical entity fields.
 * Enemies intentionally expose only qualitative HP; PCs retain exact values.
 */
export function createTokenDrawCommands(
  combat: Readonly<CombatState>,
  presentation: Readonly<Record<string, Readonly<TokenPresentation>>> = {},
): readonly TokenDrawCommand[] {
  const activeId = combat.initiative[0]?.entityId ?? null;
  const teamNames = [
    ...new Set(
      combat.entities.map(
        (entity) =>
          presentation[entity.id]?.team ??
          (entity.kind === 'character' ? 'party' : entity.kind),
      ),
    ),
  ].sort();
  const teamIndices = new Map(teamNames.map((team, index) => [team, index]));

  return combat.entities.map((entity) => {
    const details = presentation[entity.id] ?? {};
    const team =
      details.team ?? (entity.kind === 'character' ? 'party' : entity.kind);
    const maxHp = details.maxHp ?? Math.max(entity.hp, 1);
    const conditions = (details.conditions ?? []).map((condition) => {
      const label = condition.trim();
      const key = label.toLowerCase();
      return { icon: CONDITION_ICONS[key] ?? '•', label };
    });
    return {
      type: 'token',
      entityId: entity.id,
      name: details.name ?? entity.id,
      x: entity.pos.x,
      y: entity.pos.y,
      footprint: entity.size,
      team,
      teamMarker: markerFor(team, teamIndices.get(team) ?? 0),
      hpLabel: hpLabel(entity.kind, entity.hp, maxHp),
      conditions,
      active: entity.id === activeId,
    };
  });
}
