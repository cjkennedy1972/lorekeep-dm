import { readFileSync } from 'node:fs';
import {
  type CombatCase,
  type ExploreCase,
  type RulesCase,
  type ToolCase,
  mapContradictions,
  puppets,
  rulesCorrect,
  toolCallValid,
} from './score.js';
import type { EvalModel, EvalRecord, SuiteName, SuiteResult } from './types.js';

const data = (name: string) =>
  JSON.parse(
    readFileSync(new URL(`../data/${name}`, import.meta.url), 'utf8'),
  ) as never;
export const thresholds = data('thresholds.json') as {
  rulesCorrect: { min: number };
  puppetingRate: { max: number };
  mapContradictionRate: { max: number };
  toolValidity: { min: number };
};
export const NOTE =
  'v0 datasets are too small for statistical claims (rules 50, exploration 50, combat 30, tool calls 20). Thresholds are initial targets (spec A10).';

/** fnv1a: per-case seed from the run seed, stable across runs. */
const caseSeed = (seed: number, id: string) =>
  [...`${seed}:${id}`].reduce(
    (h, ch) => Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0,
    2166136261,
  );

export async function runEval(
  model: EvalModel,
  opts: {
    mode: EvalRecord['mode'];
    endpointProfileId: string;
    modelName: string;
    seed?: number;
    now?: () => Date;
  },
): Promise<EvalRecord> {
  const seed = opts.seed ?? 1;
  const ask = (suite: SuiteName, caseId: string, prompt: string) =>
    model({ suite, caseId, prompt, seed: caseSeed(seed, caseId) });
  /** run → true when the case is OK. score = OK fraction, or flagged fraction when asRate. */
  const suite = async <T extends { id: string }>(
    items: T[],
    run: (c: T) => Promise<boolean>,
    pass: (score: number) => boolean,
    asRate = false,
  ): Promise<SuiteResult> => {
    const failures: string[] = [];
    for (const c of items) if (!(await run(c))) failures.push(c.id);
    const score =
      (asRate ? failures.length : items.length - failures.length) /
      items.length;
    return { score, n: items.length, failures, pass: pass(score) };
  };
  const rules = data('rules.json') as { cases: RulesCase[] };
  const suites: Record<SuiteName, SuiteResult> = {
    rules: await suite(
      rules.cases,
      async (c) =>
        rulesCorrect(
          c,
          await ask(
            'rules',
            c.id,
            `Rules check: ${c.question}\nAnswer briefly from the SRD excerpts and cite the excerpt id in square brackets, or say "DM discretion".\n\n${c.context.map((x) => `[${x.id}] ${x.text}`).join('\n\n')}`,
          ),
        ),
      (r) => r >= thresholds.rulesCorrect.min,
    ),
    puppeting: await suite(
      data('explore.json') as ExploreCase[],
      async (c) =>
        !puppets(
          c,
          await ask(
            'puppeting',
            c.id,
            `You are the DM. Scene: ${c.scene}. ${c.pc} says: "${c.playerAction}" Narrate in second person; never narrate ${c.pc}'s thoughts or actions.`,
          ),
        ),
      (r) => r < thresholds.puppetingRate.max,
      true,
    ),
    mapContradiction: await suite(
      data('combat.json') as CombatCase[],
      async (c) =>
        mapContradictions(
          c,
          await ask(
            'mapContradiction',
            c.id,
            `You are the DM. Authoritative map state: ${JSON.stringify(c.entities)}. ${c.action} Narrate the result without contradicting the map.`,
          ),
        ).length === 0,
      (r) => r < thresholds.mapContradictionRate.max,
      true,
    ),
    toolValidity: await suite(
      data('tools.json') as ToolCase[],
      async (c) =>
        toolCallValid(
          c,
          await ask(
            'toolValidity',
            c.id,
            `${c.instruction}\nTools: ${JSON.stringify(c.tools)}\nReply with only JSON {"name":...,"arguments":{...}}.`,
          ),
        ),
      (r) => r >= thresholds.toolValidity.min,
    ),
  };
  return {
    version: 1,
    mode: opts.mode,
    endpointProfileId: opts.endpointProfileId,
    model: opts.modelName,
    seed,
    ranAt: (opts.now?.() ?? new Date()).toISOString(),
    suites,
    passed: Object.values(suites).every((s) => s.pass),
    note: NOTE,
  };
}

export const recordedModel = (fixturePath: URL | string): EvalModel => {
  const fx = JSON.parse(readFileSync(fixturePath, 'utf8')) as Record<
    SuiteName,
    Record<string, string>
  >;
  return async ({ suite, caseId }) => {
    const r = fx[suite]?.[caseId];
    if (r === undefined)
      throw new Error(
        `recorded fixture has no response for ${suite}/${caseId}`,
      );
    return r;
  };
};
