export interface RulesCase {
  id: string;
  question: string;
  citation: string;
  keywords: string[];
  context: { id: string; text: string }[];
}
export interface ExploreCase {
  id: string;
  pc: string;
  scene: string;
  playerAction: string;
}
export interface Entity {
  name: string;
  kind: 'pc' | 'foe';
  x: number;
  y: number;
  alive: boolean;
}
export interface CombatCase {
  id: string;
  grid: { width: number; height: number };
  entities: Entity[];
  action: string;
}
export interface ToolDef {
  name: string;
  description: string;
  parameters: Schema;
}
export interface ToolCase {
  id: string;
  instruction: string;
  tools: ToolDef[];
  expectTool: string;
  args: unknown;
}
interface Schema {
  type?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean;
  enum?: unknown[];
}

export const rulesCorrect = (c: RulesCase, reply: string): boolean => {
  const text = reply.toLowerCase();
  return (
    text.includes(c.citation) &&
    c.keywords.every((k) => text.includes(k.toLowerCase()))
  );
};

const PUPPET_VERBS =
  'feel|feels|felt|think|thinks|thought|decide|decides|decided|realize|realizes|wonder|wonders|want|wants|wish|wishes|smile|smiles|nod|nods|sigh|sighs|step|steps|walk|walks|draw|draws|reach|reaches|say|says|shout|shouts|whisper|whispers|grab|grabs|open|opens|attack|attacks';
/** R-N3: flag narrated PC thoughts/actions the player did not request. */
export const puppets = (c: ExploreCase, reply: string): boolean => {
  const re = new RegExp(`\\b(?:you|${c.pc})\\s+(${PUPPET_VERBS})\\b`, 'gi');
  const asked = c.playerAction.toLowerCase();
  return [...reply.matchAll(re)].some(
    (m) => !asked.includes(m[1]!.toLowerCase()),
  );
};

const FOE_VOCAB = [
  'ogre',
  'troll',
  'dragon',
  'owlbear',
  'wraith',
  'giant',
  'lich',
  'minotaur',
];
const ACT =
  'attacks|strikes|swings|lunges|charges|snarls|slashes|bites|shoots|casts|roars';
const dist = (a: Entity, b: Entity) =>
  Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
/** R-N5: narration contradicts the authoritative map state. Returns the reasons found. */
export const mapContradictions = (c: CombatCase, reply: string): string[] => {
  const pc = c.entities.find((e) => e.kind === 'pc')!;
  const out: string[] = [];
  for (const e of c.entities.filter((x) => x.kind === 'foe')) {
    const n = e.name.toLowerCase();
    if (!e.alive && new RegExp(`\\b${n}\\s+(?:${ACT})\\b`, 'i').test(reply))
      out.push(`dead ${e.name} acts`);
    if (
      dist(pc, e) > 1 &&
      new RegExp(
        `${n}[^.]*\\b(?:adjacent|beside|next to|within reach)\\b`,
        'i',
      ).test(reply)
    )
      out.push(`${e.name} wrongly adjacent`);
  }
  const known = c.entities.map((e) => e.name.toLowerCase()).join(' ');
  for (const v of FOE_VOCAB)
    if (new RegExp(`\\b${v}\\b`, 'i').test(reply) && !known.includes(v))
      out.push(`unknown entity ${v}`);
  return out;
};

const typeOk = (v: unknown, t?: string) =>
  !t ||
  (t === 'integer'
    ? Number.isInteger(v)
    : t === 'array'
      ? Array.isArray(v)
      : t === 'object'
        ? typeof v === 'object' && v !== null && !Array.isArray(v)
        : typeof v === t);
const valid = (v: unknown, s: Schema): boolean => {
  if (!typeOk(v, s.type) || (s.enum && !s.enum.includes(v))) return false;
  if (s.type !== 'object') return true;
  const o = v as Record<string, unknown>,
    props = s.properties ?? {};
  if ((s.required ?? []).some((k) => !(k in o))) return false;
  return Object.entries(o).every(([k, x]) =>
    k in props ? valid(x, props[k]!) : s.additionalProperties !== false,
  );
};
/** Valid iff reply is a JSON {name, arguments} call to the expected tool that satisfies its schema (no coordinates: schemas forbid extras). */
export const toolCallValid = (c: ToolCase, reply: string): boolean => {
  try {
    const call = JSON.parse(
      reply.trim().replace(/^```(?:json)?|```$/g, ''),
    ) as { name?: unknown; arguments?: unknown };
    const tool = c.tools.find((t) => t.name === call.name);
    return (
      !!tool &&
      tool.name === c.expectTool &&
      valid(call.arguments, tool.parameters)
    );
  } catch {
    return false;
  }
};
