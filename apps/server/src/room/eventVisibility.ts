/**
 * ADR-034 §3: which fields of each committed combat event hold entity ids.
 * `scalars`: a hidden, uncontrolled id drops the whole event. `lists`: hidden ids are redacted out of the array
 * (strings, or objects keyed by `id`). An event type with no entry fails closed: it is sent to no one.
 */
type Rule = { scalars?: string[]; lists?: string[] };

const subject: Rule = { scalars: ['entityId'] };
const none: Rule = {};

export const EVENT_ID_RULES: Readonly<Record<string, Rule>> = {
  CombatStarted: { lists: ['order', 'combatants'] },
  CombatEnded: none,
  InitiativeRolled: subject,
  TurnOpened: subject,
  TurnTimedOut: subject,
  TurnStarted: subject,
  TurnEnded: subject,
  ActionSpent: subject,
  BonusActionSpent: subject,
  ReactionSpent: subject,
  MovementSpent: subject,
  MoveStarted: subject,
  MoveEnded: subject,
  EntityMoved: subject,
  EntityPlaced: subject,
  EntityDown: subject,
  HpChanged: subject,
  RollEvent: { scalars: ['entityId', 'actorId'] },
  ConditionApplied: subject,
  ConditionRemoved: subject,
  ConditionsTicked: subject,
  ActionsSkipped: subject,
  ConcentrationStarted: subject,
  ConcentrationDropped: subject,
  ConcentrationChecked: subject,
  SlotSpent: subject,
  SpellCast: subject,
  AreaResolved: { lists: ['affected'] },
  OpportunityTriggered: { scalars: ['moverId', 'attackerId'] },
  ReactionAvailable: subject,
  ReactionResolved: subject,
  // Party prompt lifecycle (ADR-033 §3). Answered/Declined carry only a promptId; Room hides them for a hidden reactor.
  ReactionPromptOpened: { scalars: ['reactorEntityId'] },
  ReactionAnswered: none,
  ReactionDeclined: none,
  DodgeDeclared: subject,
  MonsterPolicy: { scalars: ['monsterId'] },
  AttackRefused: { scalars: ['entityId', 'attackerId', 'targetId'] },
  DeathSaveRolled: none,
  CharacterDied: subject,
  FailForwardChosen: none,
};

/** The event as `viewer` may see it, or null when it must not be sent. */
export function projectEventForViewer(
  event: Record<string, unknown>,
  hidden: ReadonlySet<string>,
  controlled: ReadonlySet<string>,
): Record<string, unknown> | null {
  const rule = EVENT_ID_RULES[String(event.type)];
  if (!rule) return null;
  const masked = (id: unknown) =>
    typeof id === 'string' && hidden.has(id) && !controlled.has(id);
  if (rule.scalars?.some((key) => masked(event[key]))) return null;
  if (!rule.lists) return event;
  const out = { ...event };
  for (const key of rule.lists) {
    const list = event[key];
    if (!Array.isArray(list)) continue;
    out[key] = list.filter(
      (item) =>
        !masked(
          item && typeof item === 'object'
            ? (item as { id?: unknown }).id
            : item,
        ),
    );
  }
  return out;
}

/** True when the event names a hidden entity at all (narration uses this with nothing controlled). */
export function namesHiddenEntity(
  event: Record<string, unknown>,
  hidden: ReadonlySet<string>,
): boolean {
  const out = projectEventForViewer(event, hidden, new Set());
  return out === null || out !== event;
}

/**
 * Wire messages (not committed events) that carry combat state. Every one must be declared:
 * 'projected' = built per viewer from the projections here and in combat.ts, 'actor' = sent only to the acting seat.
 */
export const WIRE_MESSAGE_RULES: Readonly<
  Record<string, 'projected' | 'actor'>
> = {
  CombatTracker: 'projected',
  ReactionPrompt: 'projected',
  ReactionPromptOpen: 'projected',
  CombatOptions: 'actor',
};

/**
 * ADR-034 §3: a prompt for a hidden reactor goes only to its controller; others learn nothing (no "open", no deadline).
 * A prompt whose mover is hidden from the viewer is likewise withheld unless the viewer controls the reactor.
 * Visible reactors keep the ADR-033 broadcast unchanged.
 */
export function reactionPromptVisibleTo(
  prompt: { entityId: string; moverId?: string },
  hidden: ReadonlySet<string>,
  controlled: ReadonlySet<string>,
): boolean {
  const masked = (id: string | undefined) =>
    id !== undefined && hidden.has(id) && !controlled.has(id);
  return (
    !masked(prompt.entityId) &&
    (!masked(prompt.moverId) || controlled.has(prompt.entityId))
  );
}
