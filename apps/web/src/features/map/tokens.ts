import type { CombatState } from '@game/schema';
import { nameFromCatalogId } from './names.js';

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
  /** Only a real max (from the sheet). Never derived from current HP. */
  readonly maxHp?: number;
  /** Server status word: `healthy` | `wounded` | `down`. */
  readonly hpState?: string;
  readonly conditions?: readonly string[];
}

export type HpWord = 'healthy' | 'bloodied' | 'down' | 'unknown';

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

/**
 * The status word for a combatant. Exact HP and a real max decide it when both are known (at or below half is
 * bloodied, 0 is down); otherwise the server's hpState (`wounded` means bloodied) does.
 */
export function hpWord(
  hp: number | undefined,
  maxHp: number | undefined,
  hpState?: string,
): HpWord {
  if (hp === 0 || hpState === 'down') return 'down';
  if (typeof hp === 'number' && typeof maxHp === 'number' && maxHp > 0)
    return hp * 2 <= maxHp ? 'bloodied' : 'healthy';
  if (hpState === 'wounded') return 'bloodied';
  if (hpState === 'healthy') return 'healthy';
  return 'unknown';
}

function hpLabel(
  kind: string,
  hp: number | undefined,
  maxHp: number | undefined,
  hpState?: string,
): string {
  const word = hpWord(hp, maxHp, hpState);
  if (kind === 'character' && typeof hp === 'number') {
    const amount = typeof maxHp === 'number' ? `HP ${hp}/${maxHp}` : `HP ${hp}`;
    return word === 'unknown' ? amount : `${amount} (${word})`;
  }
  return word;
}

/**
 * Creates one deterministic token instruction per combatant. Presentation data is
 * optional because the M1 combat schema stores only mechanical entity fields.
 * Enemies intentionally expose only qualitative HP; PCs retain exact values.
 */
export function createTokenDrawCommands(
  combat: Readonly<CombatState> & { activeEntityId?: string | null },
  presentation: Readonly<Record<string, Readonly<TokenPresentation>>> = {},
): readonly TokenDrawCommand[] {
  // Active only: null/absent means no active token, never initiative[0].
  const activeId = combat.activeEntityId ?? null;
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
    const maxHp = details.maxHp;
    const conditions = (details.conditions ?? []).map((condition) => {
      const label = condition.trim();
      const key = label.toLowerCase();
      return { icon: CONDITION_ICONS[key] ?? '•', label };
    });
    return {
      type: 'token',
      entityId: entity.id,
      name: details.name ?? nameFromCatalogId(entity.id),
      x: entity.pos.x,
      y: entity.pos.y,
      footprint: entity.size,
      team,
      teamMarker: markerFor(team, teamIndices.get(team) ?? 0),
      hpLabel: hpLabel(entity.kind, entity.hp, maxHp, details.hpState),
      conditions,
      active: entity.id === activeId,
    };
  });
}
