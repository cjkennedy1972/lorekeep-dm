/**
 * Turns one `CombatEvents` batch into per-attack roll cards.
 *
 * The wire carries no hit/miss and no target on the attack roll. A hit is an attack roll immediately followed by a
 * damage roll from the same attacker, and the target comes from the HP change after it. A miss has no target on the
 * wire.
 *
 * Disclosure, decided from the viewer's own entities and never from the label shape:
 * - The attack total is shown only for the viewer's own attacks.
 * - Damage numbers are shown when the viewer's own PC is hit, or when the viewer's own attack hits a monster.
 * - A PC's HP from/to is shown only for the viewer's own PC. Another seat's PC gets a wound word, if any.
 * - Monster HP is never a number; a monster is reported as down or still standing.
 */

export type RollCard = {
  attackerId: string;
  targetId?: string;
  /** Humanized from the attack id, for example `equipment:javelin` -> `Javelin`. */
  weapon?: string;
  /** True only when the attacker is one of the viewer's own entities. */
  owned: boolean;
  attackTotal?: number;
  hit: boolean;
  damage?: number;
  targetKind?: Kind;
  /** Only for the viewer's own PC. */
  targetHp?: { from: number; to: number };
  /** Another seat's PC that is wounded but not down. */
  wound?: 'bloodied';
  down: boolean;
  standing?: boolean;
};

export type Kind = 'pc' | 'monster';
export type CombatantFacts = {
  kind: Kind;
  /** The server's status word: `healthy`, `wounded` or `down`. */
  hpState?: string;
};
type Loose = Record<string, unknown>;

function asEvent(raw: unknown): Loose | null {
  return raw && typeof raw === 'object' ? (raw as Loose) : null;
}

function rollKind(label: unknown): {
  kind: 'attack' | 'damage';
  attackId?: string;
} | null {
  const match = /^(attack|damage)(?: (.+))?$/.exec(String(label ?? ''));
  if (!match) return null;
  return {
    kind: match[1] as 'attack' | 'damage',
    attackId: match[2],
  };
}

function weaponName(attackId: string | undefined): string | undefined {
  if (!attackId) return undefined;
  const slug = attackId.split(':').pop() ?? attackId;
  const words = slug
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word[0]!.toUpperCase() + word.slice(1));
  return words.length ? words.join(' ') : undefined;
}

function numeric(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

/**
 * The roll right after an attack counts as its damage only when it is a damage roll from the same actor. Labels that
 * carry an attack id must agree, so a spell's damage cannot be paired with a miss by the same caster.
 */
function isDamageFor(
  candidate: Loose | null,
  attack: { attackId?: string },
  attackerId: string,
): boolean {
  if (candidate?.type !== 'RollEvent') return false;
  const damage = rollKind(candidate.label);
  if (damage?.kind !== 'damage') return false;
  if (String(candidate.actorId ?? '') !== attackerId) return false;
  return (
    damage.attackId === undefined ||
    attack.attackId === undefined ||
    damage.attackId === attack.attackId
  );
}

/** The wound word another seat may see; exact HP never reaches them. */
function woundWord(facts: CombatantFacts | undefined): 'bloodied' | undefined {
  return facts?.kind === 'pc' && facts.hpState === 'wounded'
    ? 'bloodied'
    : undefined;
}

export function summarizeCombatRolls(
  events: readonly unknown[],
  combatants: Readonly<Record<string, CombatantFacts | undefined>>,
  ownEntityIds: ReadonlySet<string>,
): RollCard[] {
  const list = events.map(asEvent);
  const cards: RollCard[] = [];
  list.forEach((event, index) => {
    if (!event || event.type !== 'RollEvent') return;
    const attack = rollKind(event.label);
    if (!attack || attack.kind !== 'attack') return;
    const attackerId = String(event.actorId ?? '');
    if (!attackerId) return;

    const owned = ownEntityIds.has(attackerId);
    const attackTotal = owned ? numeric(event.total) : undefined;

    // The damage must be the next roll of any kind after this attack. Anything else in between makes it a miss.
    const damageAt = list.findIndex(
      (candidate, at) => at > index && candidate?.type === 'RollEvent',
    );
    const damageEvent = damageAt === -1 ? null : list[damageAt]!;
    const hit =
      damageEvent !== null && isDamageFor(damageEvent, attack, attackerId);

    // The HP change belongs to the hit only if it comes before the next roll.
    let hpEvent: Loose | undefined;
    if (hit) {
      for (let at = damageAt + 1; at < list.length; at += 1) {
        const candidate = list[at];
        if (candidate?.type === 'RollEvent') break;
        if (candidate?.type === 'HpChanged') {
          hpEvent = candidate;
          break;
        }
      }
    }

    const targetId = hpEvent ? String(hpEvent.entityId ?? '') : '';
    const target = targetId ? combatants[targetId] : undefined;
    const targetKind = target?.kind;
    const targetIsOwn = targetId !== '' && ownEntityIds.has(targetId);
    const from = numeric(hpEvent?.from);
    const to = numeric(hpEvent?.to);
    const down = hit && to === 0;

    const damageDealt = hit
      ? (numeric(hpEvent?.damage) ?? numeric(damageEvent?.total))
      : undefined;
    const showDamage =
      damageDealt !== undefined &&
      (targetIsOwn || (owned && targetKind === 'monster'));
    const targetHp =
      targetIsOwn &&
      targetKind === 'pc' &&
      from !== undefined &&
      to !== undefined
        ? { from, to }
        : undefined;
    const wound = !targetIsOwn && !down ? woundWord(target) : undefined;

    const card: RollCard = {
      attackerId,
      owned,
      hit,
      down,
      ...(targetId ? { targetId } : {}),
      ...(weaponName(attack.attackId)
        ? { weapon: weaponName(attack.attackId) }
        : {}),
      ...(attackTotal !== undefined ? { attackTotal } : {}),
      ...(showDamage ? { damage: damageDealt } : {}),
      ...(targetKind ? { targetKind } : {}),
      ...(targetHp ? { targetHp } : {}),
      ...(wound ? { wound } : {}),
      ...(targetKind === 'monster' && to !== undefined && !down
        ? { standing: true }
        : {}),
    };
    cards.push(card);
  });
  return cards;
}

/** One plain sentence per card, used for the list item and the batch announcement. */
export function rollCardText(
  card: RollCard,
  nameOf: (entityId: string) => string,
): string {
  const attacker = nameOf(card.attackerId);
  const weapon = card.weapon ? ` with ${card.weapon}` : '';
  const roll =
    card.attackTotal === undefined ? '' : ` (attack roll ${card.attackTotal})`;
  if (!card.hit) return `${attacker} attacks${weapon} and misses${roll}.`;
  const target = card.targetId ? nameOf(card.targetId) : 'the target';
  const damage = card.damage === undefined ? '' : ` for ${card.damage}`;
  const hp = card.targetHp
    ? ` ${target} HP ${card.targetHp.from} to ${card.targetHp.to}.`
    : '';
  const state = card.down
    ? ` ${target} is down.`
    : card.standing
      ? ` ${target} is still standing.`
      : card.wound
        ? ` ${target} is ${card.wound}.`
        : '';
  return `${attacker} hits ${target}${weapon}${damage}.${roll}${hp}${state}`
    .replace(/\s+/g, ' ')
    .trim();
}
