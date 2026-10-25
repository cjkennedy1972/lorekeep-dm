import type { Battlemap, GridPos } from '@game/schema';
import type { CharacterInput, PendingReaction } from '@game/rules-engine';

/** A reaction prompt auto-declines this long after it was issued. */
export const REACTION_TIMEOUT_MS = 15_000;

export type CombatAttack = {
  id: string;
  name: string;
  reachFt?: number;
  attackBonus: number;
  damage: string;
  damageType: string;
  range?: { normalFt: number; longFt?: number };
};
export type CombatEntity = {
  id: string;
  name?: string;
  hidden?: boolean;
  kind: 'character' | 'monster' | 'npc';
  team: string;
  pos: GridPos;
  size: number;
  hp: number;
  maxHp: number;
  ac?: number;
  speed?: number;
  abilities?: Record<'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha', number>;
  /** Total saving-throw bonuses; an ability without one falls back to its modifier. */
  saves?: Partial<
    Record<'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha', number>
  >;
  attacks?: CombatAttack[];
  /** A monster that ran away is out of the fight without being dead. */
  fled?: boolean;
};
export type CombatResourcesState = {
  action: boolean;
  bonusAction: boolean;
  /** Set only after this entity casts a bonus-action spell; reset at turn start. */
  bonusActionSpellCast?: boolean;
  /** Set only after this entity casts a leveled action spell; reset at turn start. */
  actionSpellCast?: boolean;
  reaction: boolean;
  movementRemaining: number;
};
export type CombatPhase =
  | 'awaiting-command'
  | 'moving'
  | 'reaction-pending'
  | 'narrating';
export type RoomCombatState = {
  /** Missing only in legacy snapshots; runtime admission infers it from pendingReaction. */
  phase?: CombatPhase;
  /** Stable identity and retry budget for the currently open combat turn. */
  turnId?: string;
  narrationAttempts?: number;
  turnDeadline?: number;
  /** Engine-only inputs retained with an open narration for deterministic restart retry. */
  turnNarrationEvents?: Record<string, unknown>[];
  /** Event-log sequence IDs for this turn, excluding hidden-combatant events. */
  turnNarrationEventIds?: string[];
  map: Battlemap;
  entities: CombatEntity[];
  combat: {
    round: number;
    activeEntityId: string | null;
    initiative: { entityId: string; total: number }[];
    resources: Record<string, CombatResourcesState>;
  };
  /** Active Dodge effects expire when that entity's next turn begins. */
  dodging?: string[];
  /** The prompt shown to the table. `deadlineAt` is an absolute epoch-ms so a restart can resume the countdown. */
  pendingReaction?: {
    reactionId: string;
    entityId: string;
    trigger: string;
    moverId: string;
    deadlineAt: number;
  };
  /** Engine continuations (remaining path) for every unresolved reaction of the current mover. */
  engineReactions?: Record<string, PendingReaction>;
  pendingActionIds?: string[];
  concentration?: Record<string, string | null>;
  /** Deterministic RNG cursor; every roll advances it. */
  seed?: number;
  ended?: { outcome: string };
};
/** Spell-slot changes of a caster the Room must write back to the character sheet. */
export type SlotPatch = Record<string, { max: number; used: number }>;
export type CombatTransition = {
  state: RoomCombatState;
  events: Record<string, unknown>[];
  messages?: { type: string; payload: Record<string, unknown> }[];
  slots?: { entityId: string; slots: SlotPatch };
};
export type CombatCommandError = {
  code:
    | 'COMMAND_REJECTED'
    | 'not-your-turn'
    | 'move-in-progress'
    | 'reaction-window-open'
    | 'narration-in-progress';
  message: string;
};
export type CombatContext = {
  character?: CharacterInput;
  now?: number;
};
