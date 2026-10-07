import type { Ability, CatalogEntry } from '@game/schema';
import { nextDie, seedRng, type RngState } from '../rng.js';
import { deriveSheet } from './derive.js';
import { validateCharacter } from './validate.js';
import type {
  CharacterCatalog,
  CharacterInput,
  RuleViolation,
} from './types.js';

export interface BuilderOption {
  id: string;
  label: string;
  explanation: string;
}
export type AbilityMethod = 'standard-array' | 'point-buy';
export interface QuickBuildChoice {
  step: string;
  optionId: string;
  explanation: string;
}

const ABILITIES: Ability[] = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
const ABILITY_NAME: Record<Ability, string> = {
  str: 'Strength',
  dex: 'Dexterity',
  con: 'Constitution',
  int: 'Intelligence',
  wis: 'Wisdom',
  cha: 'Charisma',
};
// Scores handed out in priority order (best score to the class's key ability).
const ARRAYS: Record<AbilityMethod, number[]> = {
  'standard-array': [15, 14, 13, 12, 10, 8],
  'point-buy': [15, 15, 13, 10, 8, 8], // 9+9+5+2 = 25 of 27 points
};
const METHOD_TEXT: Record<AbilityMethod, string> = {
  'standard-array':
    'Fixed scores 15, 14, 13, 12, 10 and 8, placed on your best abilities.',
  'point-buy':
    'Spend 27 points on scores from 8 to 15; this preset favours your top two abilities.',
};

const skillId = (name: string) => name.toLowerCase().replaceAll(' ', '-');
const titleOf = (id: string) =>
  id.replaceAll('-', ' ').replace(/^./, (c) => c.toUpperCase());
const list = (xs: string[]) => xs.join(', ');
const of = <K extends CatalogEntry['kind']>(
  catalog: CharacterCatalog,
  kind: K,
) =>
  catalog.entries.filter(
    (e): e is Extract<CatalogEntry, { kind: K }> => e.kind === kind,
  );

/** Strip a leading count and trailing plural so "4 Handaxes" finds Handaxe. */
function findItem(catalog: CharacterCatalog, text: string) {
  const name = text
    .replace(/^\d+\s+/, '')
    .toLowerCase()
    .trim();
  return of(catalog, 'equipment').find((e) => {
    const n = e.name.toLowerCase();
    return n === name || `${n}s` === name;
  });
}

export class CharacterBuilder {
  private classId?: string;
  private backgroundId?: string;
  private speciesId?: string;
  private method?: AbilityMethod;
  private skills?: string[];
  private equipmentOption?: string;
  private charName = '';

  constructor(private readonly catalog: CharacterCatalog) {}

  private need<K extends CatalogEntry['kind']>(
    kind: K,
    id: string | undefined,
    step: string,
  ) {
    if (!id) throw new Error(`Choose a ${step} first`);
    const entry = this.catalog.get(kind, id);
    if (!entry) throw new Error(`Unknown ${step} ${id}`);
    return entry;
  }

  classOptions(): BuilderOption[] {
    return of(this.catalog, 'class').map((c) => {
      const first = c.features?.find((f) => f.level === 1);
      return {
        id: c.id,
        label: c.name,
        explanation: `${c.name}: d${c.hitDie} hit die, key ability ${list(c.primaryAbility.map((a) => ABILITY_NAME[a]))}${first ? `; starts with ${first.name}` : ''}.`,
      };
    });
  }
  backgroundOptions(): BuilderOption[] {
    return of(this.catalog, 'background').map((b) => ({
      id: b.id,
      label: b.name,
      explanation: `${b.name}: skilled in ${list(b.skillProficiencies.map(titleOf))}; boosts ${list((b.abilityOptions ?? ABILITIES).map((a) => ABILITY_NAME[a]))}.`,
    }));
  }
  speciesOptions(): BuilderOption[] {
    return of(this.catalog, 'species').map((s) => ({
      id: s.id,
      label: s.name,
      explanation: `${s.name}: ${s.size} size, ${s.speed} ft speed.`,
    }));
  }
  abilityMethodOptions(): BuilderOption[] {
    return (Object.keys(ARRAYS) as AbilityMethod[]).map((m) => ({
      id: m,
      label: titleOf(m),
      explanation: METHOD_TEXT[m],
    }));
  }
  /** Class skill picks that do not duplicate the background's skills. */
  skillOptions(): BuilderOption[] & { count?: number } {
    const klass = this.need('class', this.classId, 'class');
    const bg = this.need('background', this.backgroundId, 'background');
    const out = (klass.skillChoices?.from ?? [])
      .map(skillId)
      .filter((s) => !bg.skillProficiencies.includes(s))
      .map((s) => ({
        id: s,
        label: titleOf(s),
        explanation: `${titleOf(s)}: add your proficiency bonus to ${titleOf(s)} checks.`,
      }));
    return out;
  }
  skillCount(): number {
    return this.need('class', this.classId, 'class').skillChoices?.count ?? 0;
  }
  /** Only starting-equipment options whose gear fully resolves in the catalog. */
  equipmentOptions(): BuilderOption[] {
    const klass = this.need('class', this.classId, 'class');
    return (klass.startingEquipment ?? [])
      .filter(
        (o) =>
          !this.violations(this.assemble(o.option)).some((v) =>
            ['WRONG_EQUIPMENT', 'ABSENT_EQUIPMENT'].includes(v.code),
          ),
      )
      .map((o) => ({
        id: o.option,
        label: `Option ${o.option}`,
        explanation: `Start with ${list(o.items)}.`,
      }));
  }

  private pick(options: BuilderOption[], id: string, step: string): string {
    if (!options.some((o) => o.id === id))
      throw new Error(`${id} is not a legal ${step} option`);
    return id;
  }
  setClass(id: string) {
    this.classId = this.pick(this.classOptions(), id, 'class');
    this.skills = this.equipmentOption = undefined;
    return this;
  }
  setBackground(id: string) {
    this.backgroundId = this.pick(this.backgroundOptions(), id, 'background');
    this.skills = undefined;
    return this;
  }
  setSpecies(id: string) {
    this.speciesId = this.pick(this.speciesOptions(), id, 'species');
    return this;
  }
  setAbilityMethod(id: string) {
    this.method = this.pick(
      this.abilityMethodOptions(),
      id,
      'ability method',
    ) as AbilityMethod;
    return this;
  }
  setSkills(ids: string[]) {
    const legal = this.skillOptions();
    for (const id of ids) this.pick(legal, id, 'skill');
    if (new Set(ids).size !== ids.length || ids.length !== this.skillCount())
      throw new Error(`Pick exactly ${this.skillCount()} different skills`);
    this.skills = ids;
    return this;
  }
  setEquipment(option: string) {
    this.equipmentOption = this.pick(
      this.equipmentOptions(),
      option,
      'equipment',
    );
    return this;
  }
  setName(name: string) {
    if (!name.trim()) throw new Error('Name must not be empty');
    this.charName = name.trim();
    return this;
  }

  private violations(c: CharacterInput): RuleViolation[] {
    return validateCharacter(c, this.catalog);
  }

  private assemble(equipmentOption?: string): CharacterInput {
    const klass = this.need('class', this.classId, 'class');
    const bg = this.need('background', this.backgroundId, 'background');
    const method = this.method ?? 'standard-array';
    // Best scores to the key ability, then Con, Dex, Wis, Int, Cha, Str.
    const order = [
      ...new Set([
        ...klass.primaryAbility,
        'con',
        'dex',
        'wis',
        'int',
        'cha',
        'str',
      ]),
    ] as Ability[];
    const base = {} as Record<Ability, number>;
    order.forEach((a, i) => (base[a] = ARRAYS[method][i]!));
    // Background boost: +2 to the first offered ability that is a key ability
    // (else the first offered), +1 to the next.
    const offered = bg.abilityOptions?.length ? bg.abilityOptions : ABILITIES;
    const ranked = [...offered].sort(
      (a, b) => order.indexOf(a) - order.indexOf(b),
    );
    const asi = [
      { ability: ranked[0]!, amount: 2 },
      { ability: ranked[1]!, amount: 1 },
    ];
    const abilities = { ...base };
    for (const x of asi) abilities[x.ability] += x.amount;

    const option = klass.startingEquipment?.find(
      (o) => o.option === equipmentOption,
    );
    const equipment = (option?.items ?? []).flatMap((text) => {
      const item = findItem(this.catalog, text);
      const qty = Number(/^\d+/.exec(text)?.[0] ?? 1);
      return item
        ? [{ itemId: item.id, qty, equipped: item.category !== 'gear' }]
        : [];
    });

    const spellAbility = klass.spellcastingAbility;
    const spells = spellAbility
      ? of(this.catalog, 'spell').filter((s) =>
          s.classes.includes(klass.name.toLowerCase()),
        )
      : [];
    const take = (level: number, n: number) =>
      spells
        .filter((s) => s.level === level)
        .slice(0, n)
        .map((s) => s.id);
    const slots: CharacterInput['slots'] = {};
    const pact = klass.pactMagic?.[0];
    if (pact) slots[String(pact.slotLevel)] = { max: pact.slots, used: 0 };
    (klass.spellSlots?.[0] ?? []).forEach((n, i) => {
      if (n) slots[String(i + 1)] = { max: n, used: 0 };
    });

    const char: CharacterInput = {
      id: `character:${klass.id.split(':')[1]}`,
      name: this.charName || 'Unnamed Hero',
      speciesId: this.speciesId ?? '',
      classId: klass.id,
      backgroundId: bg.id,
      level: 1,
      abilities,
      abilityGeneration: { method, baseAbilities: base, asi },
      proficiencies: {
        skills: [...bg.skillProficiencies, ...(this.skills ?? [])],
        saves: [...klass.saveProficiencies],
        tools: [],
      },
      equipment,
      spellsKnown: take(0, klass.cantripsKnown?.[0] ?? 0),
      spellsPrepared: take(1, klass.preparedSpells?.[0] ?? 0),
      slots,
      hp: { current: 0, max: 0, temp: 0 },
      conditions: [],
      backgroundSkills: [...bg.skillProficiencies],
      ...(equipmentOption ? { equipmentOption } : {}),
    };
    const hp = deriveSheet(char, this.catalog).maxHp;
    char.hp = { current: hp, max: hp, temp: 0 };
    return char;
  }

  /** Assemble the level-1 character; throws unless every step is chosen and legal. */
  build(): CharacterInput {
    this.need('species', this.speciesId, 'species');
    if (!this.method) throw new Error('Choose an ability method first');
    if (!this.skills) throw new Error('Choose class skills first');
    if (!this.equipmentOption) throw new Error('Choose equipment first');
    if (!this.charName) throw new Error('Choose a name first');
    const char = this.assemble(this.equipmentOption);
    const bad = this.violations(char);
    if (bad.length)
      throw new Error(
        `Illegal character: ${bad.map((v) => v.message).join('; ')}`,
      );
    return char;
  }
}

/** Deterministic legal level-1 PC with a one-line explanation per choice. */
export function quickBuild(
  catalog: CharacterCatalog,
  classId: string | undefined,
  seed: number,
): { character: CharacterInput; choices: QuickBuildChoice[] } {
  let rng: RngState = seedRng(seed);
  const roll = (n: number) => {
    const [d, next] = nextDie(rng, n);
    rng = next;
    return d - 1;
  };
  const b = new CharacterBuilder(catalog);
  const choices: QuickBuildChoice[] = [];
  const choose = (step: string, o: BuilderOption) => {
    choices.push({ step, optionId: o.id, explanation: o.explanation });
    return o.id;
  };
  const any = (opts: BuilderOption[]) => opts[roll(opts.length)]!;

  const klassOpts = b.classOptions();
  b.setClass(
    choose(
      'class',
      classId
        ? (klassOpts.find((o) => o.id === classId) ?? any([]))
        : any(klassOpts),
    ),
  );
  b.setBackground(choose('background', any(b.backgroundOptions())));
  b.setSpecies(choose('species', any(b.speciesOptions())));
  b.setAbilityMethod(choose('abilityMethod', b.abilityMethodOptions()[0]!));

  const pool = b.skillOptions();
  const picked: BuilderOption[] = [];
  while (picked.length < b.skillCount())
    picked.push(...pool.splice(roll(pool.length), 1));
  picked.forEach((o) => choose('skill', o));
  b.setSkills(picked.map((o) => o.id));

  b.setEquipment(choose('equipment', b.equipmentOptions()[0]!));
  const name = `Hero ${seed}`;
  choices.push({
    step: 'name',
    optionId: name,
    explanation: 'A placeholder name; rename your hero any time.',
  });
  b.setName(name);
  return { character: b.build(), choices };
}
