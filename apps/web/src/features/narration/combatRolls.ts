/**
 * Turns one `CombatEvents` batch into per-attack roll cards.
 *
 * The wire carries no hit/miss and no target on the attack roll. A hit is an attack roll followed by a damage roll
 * from the same attacker, and the target comes from the HP change after it. A miss has no target on the wire.
 *
 * Disclosure: the attack total is shown only for the viewer's own rolls (concealed labels are bare). Monster HP is
 * never a number; a monster is reported as down or still standing. PC HP and damage numbers are shown because the
 * party already sees them.
 */

export type RollCard = {
  attackerId: string;
  targetId?: string;
  /** Humanized from the attack id, for example `equipment:javelin` -> `Javelin`. */
  weapon?: string;
  /** True when the server sent the roll with its attack id, which only happens for the viewer's own rolls. */
  owned: boolean;
  attackTotal?: number;
  hit: boolean;
  damage?: number;
  targetKind?: 'pc' | 'monster';
  targetHp?: { from: number; to: number };
  down: boolean;
  standing?: boolean;
};

type Kind = 'pc' | 'monster';
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

export function summarizeCombatRolls(
  events: readonly unknown[],
  kindOf: (entityId: string) => Kind | undefined,
): RollCard[] {
  const list = events.map(asEvent);
  const cards: RollCard[] = [];
  list.forEach((event, index) => {
    if (!event || event.type !== 'RollEvent') return;
    const roll = rollKind(event.label);
    if (!roll || roll.kind !== 'attack') return;
    const attackerId = String(event.actorId ?? '');
    if (!attackerId) return;

    const owned = roll.attackId !== undefined;
    const attackTotal = owned ? numeric(event.total) : undefined;

    // The batch's attacks are ordered; this attack's result is everything before the next attack roll.
    let end = index + 1;
    while (end < list.length) {
      const next = list[end];
      if (next?.type === 'RollEvent' && rollKind(next.label)?.kind === 'attack')
        break;
      end += 1;
    }
    const window = list.slice(index + 1, end);
    const damageEvent = window.find(
      (candidate) =>
        candidate?.type === 'RollEvent' &&
        rollKind(candidate.label)?.kind === 'damage' &&
        String(candidate.actorId ?? '') === attackerId,
    );
    const hpEvent = window.find((candidate) => candidate?.type === 'HpChanged');
    const hit = damageEvent !== undefined;

    const targetId = hpEvent ? String(hpEvent.entityId ?? '') : '';
    const targetKind = targetId ? kindOf(targetId) : undefined;
    const from = numeric(hpEvent?.from);
    const to = numeric(hpEvent?.to);
    const down = to === 0;

    const damageDealt = hit
      ? (numeric(hpEvent?.damage) ?? numeric(damageEvent?.total))
      : undefined;
    const showDamage =
      damageDealt !== undefined && (owned || targetKind === 'pc');

    const card: RollCard = {
      attackerId,
      owned,
      hit,
      down,
      ...(targetId ? { targetId } : {}),
      ...(weaponName(roll.attackId)
        ? { weapon: weaponName(roll.attackId) }
        : {}),
      ...(attackTotal !== undefined ? { attackTotal } : {}),
      ...(showDamage ? { damage: damageDealt } : {}),
      ...(targetKind ? { targetKind } : {}),
      ...(targetKind === 'pc' && from !== undefined && to !== undefined
        ? { targetHp: { from, to } }
        : {}),
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
      : '';
  return `${attacker} hits ${target}${weapon}${damage}.${roll}${hp}${state}`
    .replace(/\s+/g, ' ')
    .trim();
}
