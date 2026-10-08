import type { Ability, CatalogEntry } from '@game/schema';
import type { Catalog } from '../catalog/types.js';

export type CharacterInput = {
  id: string;
  name: string;
  speciesId: string;
  classId: string;
  backgroundId: string;
  level: number;
  xp?: number;
  abilities: Record<Ability, number>;
  proficiencies: { skills: string[]; saves: Ability[]; tools: string[] };
  equipment: { itemId: string; qty: number; equipped: boolean }[];
  spellsKnown: string[];
  spellsPrepared: string[];
  slots: Record<string, { max: number; used: number }>;
  hp: { current: number; max: number; temp: number };
  /** Number of this character's Hit Dice already spent since their last long rest. */
  hitDiceSpent?: number;
  /** Expended per-feature uses, keyed by stable feature id. */
  featureUses?: Record<string, number>;
  /** Chosen subclass catalog id, once the class grants a subclass. */
  subclassId?: string;
  levelUpAsi?: { ability: Ability; amount: number }[];
  conditions: { conditionId: string; source?: string; duration?: number }[];
  abilityGeneration?: {
    method: 'point-buy' | 'standard-array' | 'manual';
    baseAbilities: Record<Ability, number>;
    asi?: { ability: Ability; amount: number }[];
  };
  equipmentOption?: string;
  backgroundSkills?: string[];
};

export type RuleViolationCode =
  | 'UNKNOWN_SPECIES'
  | 'UNKNOWN_CLASS'
  | 'UNKNOWN_BACKGROUND'
  | 'ABILITY_RANGE'
  | 'POINT_BUY_TOTAL'
  | 'POINT_BUY_RANGE'
  | 'STANDARD_ARRAY'
  | 'ASI_NOT_ALLOWED'
  | 'BACKGROUND_SKILL_COUNT'
  | 'INVALID_PROFICIENCY'
  | 'DUPLICATE_PROFICIENCY'
  | 'WRONG_EQUIPMENT'
  | 'ABSENT_EQUIPMENT'
  | 'UNKNOWN_SPELL'
  | 'SPELL_NOT_ON_CLASS_LIST'
  | 'LEVEL_OUT_OF_RANGE'
  | 'SUBCLASS_REQUIRED'
  | 'ILLEGAL_SUBCLASS'
  | 'HP_MISMATCH'
  | 'WRONG_SPELL_SLOTS'
  | 'TOO_MANY_SPELLS'
  | 'MISSING_SUBCLASS';
export interface RuleViolation {
  code: RuleViolationCode;
  path: string;
  message: string;
}
export type CharacterCatalog =
  | Catalog
  | {
      entries: readonly CatalogEntry[];
      get<K extends CatalogEntry['kind']>(
        kind: K,
        id: string,
      ): Extract<CatalogEntry, { kind: K }> | undefined;
      getAny(id: string): CatalogEntry | undefined;
    };
