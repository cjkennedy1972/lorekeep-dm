import type { Battlemap, GridPos } from '@game/schema';
import type { CharacterInput, PendingReaction } from '@game/rules-engine';

/** A reaction prompt auto-declines this long after it was issued. */
export const REACTION_TIMEOUT_MS = 15_000;
/** Cumulative open-window time one turn may spend on reactions; only exhaustion of this budget declines further triggers with `cap` (ADR-033 §3.8). */
export const REACTION_BUDGET_MS = 45_000;
export type ReactionDeclineCause =
  | 'timeout'
  | 'presence'
  | 'no-controller'
  | 'auto'
  | 'cap'
  | 'combat-ended'
  | 'restart';

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
  /** Absolute epoch-ms expiry of the running turn timer (ADR-033 §5, §7.2); absent when off or frozen. */
  turnDeadline?: number;
  /** Time left on a frozen turn timer (reaction window, table pause); the deadline is rebuilt when it thaws. */
  turnTimerRemainingMs?: number;
  /** Engine-only inputs retained with an open narration for deterministic restart retry. */
  turnNarrationEvents?: Record<string, unknown>[];
  /** Party combat uses the ADR-033 prompt lifecycle events; absent for sandbox/legacy combat, which keeps ReactionAvailable/Resolved. */
  promptEvents?: true;
  /** Reaction-window time left this turn; absent means the full budget (reset when the next turn starts). */
  reactionBudgetMs?: number;
  /** Counter for opaque prompt ids. */
  promptSeq?: number;
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
    /** Party combat: opaque id used on the wire and in events; reactionId embeds entity ids and stays server-side. */
    promptId?: string;
    entityId: string;
    trigger: string;
    moverId: string;
    deadlineAt: number;
    /** Party combat: the window is open (ReactionPromptOpened emitted); until then it is only an engine trigger. */
    opened?: true;
    /** Length of the open window, for budget accounting. */
    windowMs?: number;
    /** Time left while the table is paused; deadlineAt is rebuilt on resume. */
    frozenMs?: number;
  };
  /** Engine continuations (remaining path) for every unresolved reaction of the current mover. */
  engineReactions?: Record<string, PendingReaction>;
  pendingActionIds?: string[];
  /** Engine-issued area-aim handles (DM `suggest_area_target`); each is valid only on its `expiresTurn`. */
  optionHandles?: Record<
    string,
    { pos: GridPos; expiresTurn: string; affected: string[] }
  >;
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
  /** Internal-only classification; Room never serializes this to clients. */
  attackRejectReason?:
    | 'attacker_missing'
    | 'target_unavailable'
    | 'weapon_missing'
    | 'action_unavailable'
    | 'target_dead'
    | 'target_fled'
    | 'illegal_range_or_line_of_sight'
    | 'combat_ended'
    | 'not_your_turn'
    | 'narration_in_progress'
    | 'move_in_progress'
    | 'reaction_window_open'
    | 'combat_inactive';
};
export type CombatContext = {
  character?: CharacterInput;
  now?: number;
  /** Entities controlled by the commanding viewer; hidden targets are otherwise nonexistent. */
  controlledEntityIds?: ReadonlySet<string>;
};

/** The id a reaction prompt carries on the wire and in events. */
export const promptIdOf = (prompt: {
  reactionId: string;
  promptId?: string;
}): string => prompt.promptId ?? prompt.reactionId;

/** A rewound game state must not reuse a prompt id a client already saw: keep the higher counter. */
export function carryPromptSeq(restored: unknown, live: unknown): unknown {
  const room = (g: unknown) =>
    (g as { combatRoom?: { promptSeq?: number } } | undefined)?.combatRoom;
  const seq = Math.max(
    room(restored)?.promptSeq ?? 0,
    room(live)?.promptSeq ?? 0,
  );
  if (!seq || !room(restored)) return restored;
  return {
    ...(restored as object),
    combatRoom: { ...room(restored), promptSeq: seq },
  };
}
