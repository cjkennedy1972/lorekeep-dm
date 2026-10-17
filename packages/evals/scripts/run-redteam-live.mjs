import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkLiveUrl } from '../dist/live.js';
import { DMToolArgsSchema } from '../../../packages/schema/dist/dm-tools.js';
import { buildPrompt, zodSchema } from '../../../apps/server/dist/dm/prompt.js';
import {
  buildJudgeMessages,
  parseVerdictReply,
} from '../../../apps/server/dist/safety/moderator.js';
import { MODERATION_SECTIONS } from '../../../apps/server/dist/safety/moderationRubric.generated.js';
import { checkHardFloor } from '../../../apps/server/dist/safety/hardFloor.js';
import { hardFloorLayer } from '../../../apps/server/dist/safety/deterministicLayer.js';

const baseUrl = process.env.REDTEAM_BASE_URL ?? 'http://172.31.25.75:8080/v1';
const model = process.env.REDTEAM_MODEL ?? 'qwen3.8-35b-a3b-distill-q4';
const profile = process.env.REDTEAM_PROFILE ?? 'local-qwen35';
const sourceCommit = process.env.REDTEAM_SOURCE_COMMIT;
const apiKey = process.env.EVAL_API_KEY;
if (!apiKey) throw new Error('EVAL_API_KEY is required');
if (!/^[0-9a-f]{40}$/i.test(sourceCommit ?? ''))
  throw new Error('REDTEAM_SOURCE_COMMIT must be a full 40-character Git SHA');
const checkoutCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).trim();
const checkoutChanges = execFileSync('git', ['status', '--porcelain'], {
  encoding: 'utf8',
}).trim();
if (sourceCommit.toLowerCase() !== checkoutCommit.toLowerCase())
  throw new Error(
    'REDTEAM_SOURCE_COMMIT must match the checked-out source SHA',
  );
if (checkoutChanges)
  throw new Error('The live runner requires a clean Git working tree');
const endpointUrl = checkLiveUrl(baseUrl);
if (endpointUrl.host !== '172.31.25.75:8080')
  throw new Error('This run is pinned to the documented local Qwen endpoint');

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const load = async (name) =>
  JSON.parse(await readFile(resolve(root, 'redteam', name), 'utf8'));
const datasets = {
  injection: await load('injection-100.json'),
  boundary: await load('boundary-100.json'),
  xcard: await load('xcard-redirect.json'),
};
const startedAt = new Date().toISOString();
const outputPath = resolve(
  root,
  'redteam/recorded/live-qwen3.8-35b-a3b-distill-q4-2026-10-15.json',
);
const toolNames = Object.keys(DMToolArgsSchema);
const tools = toolNames.map((name) => ({
  type: 'function',
  function: {
    name,
    description: `Validated ${name} action.`,
    parameters: zodSchema(DMToolArgsSchema[name]),
  },
}));
const syntheticCharacter = {
  id: 'ent_ayla',
  name: 'Ayla',
  speciesId: 'srd:species/human',
  classId: 'srd:class/fighter',
  backgroundId: 'srd:background/soldier',
  level: 1,
  abilities: { str: 15, dex: 12, con: 13, int: 10, wis: 11, cha: 8 },
  proficiencies: { skills: [], saves: [], tools: [] },
  equipment: [],
  spellsKnown: [],
  spellsPrepared: [],
  slots: {},
  hp: { current: 10, max: 10, temp: 0 },
  conditions: [],
};
const sha = (value) => createHash('sha256').update(value).digest('hex');
const output = {
  schema: 'redteam-live-record/2',
  endpoint: { profile, baseUrl, model },
  startedAt,
  finishedAt: null,
  versions: Object.fromEntries(
    Object.entries(datasets).map(([name, ds]) => [name, ds.version]),
  ),
  methodology: {
    sourceCommit,
    boundary:
      'Production JudgeModerator rubric/messages and deterministic hard-floor/denylist are applied. Raw judge replies and parsed verdicts are recorded.',
    injection:
      'Production input moderation and DM buildPrompt are exercised with one synthetic level-1 fighter. Dataset prior turns are included. Native DM tool calls and narration are recorded. No tool is executed; this is not a persisted game turn.',
    xcard:
      'Production buildPrompt is used with one synthetic level-1 fighter and steerAway set only for actual control cases. Native DM tool calls and narration are recorded; no tool is executed and this is not a persisted game turn.',
    outputModeration:
      'Model-generated narration is passed through the production moderation rubric in output direction. This harness records the verdict but does not emit narration to a player.',
  },
  cases: [],
};

async function chat(messages, extra = {}) {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    redirect: 'error',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: 512,
      messages,
      ...extra,
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok)
    throw new Error(`endpoint returned HTTP ${response.status}`);
  const data = await response.json();
  const choice = data.choices?.[0];
  if (!choice?.message) throw new Error('endpoint returned no chat message');
  return {
    content: choice.message.content ?? '',
    toolCalls: (choice.message.tool_calls ?? []).map((call) => ({
      name: call.function?.name ?? null,
      arguments: call.function?.arguments ?? null,
    })),
    finishReason: choice.finish_reason ?? null,
    usage: data.usage ?? null,
  };
}

async function moderate({ text, tier, direction, tableLines = [] }) {
  const hard = checkHardFloor(text);
  if (hard.blocked)
    return {
      verdict: 'block',
      category: hard.rule === 'input.over-limit' ? 'other' : 'minor_sexual',
      source: 'hardfloor',
      unavailable: false,
      raw: null,
    };
  const denied = hardFloorLayer.denylistCheck(text);
  if (denied.blocked)
    return {
      verdict: 'block',
      category: denied.category ?? 'other',
      source: 'denylist',
      unavailable: false,
      raw: null,
    };
  const messages = buildJudgeMessages({ text, tier, direction, tableLines });
  const result = await chat(messages, { max_tokens: 1024 });
  const parsed = parseVerdictReply(result.content);
  return {
    ...(parsed ?? { verdict: 'block', category: 'other' }),
    source: parsed ? 'judge' : 'failclosed-parse',
    unavailable: !parsed,
    raw: result.content,
    finishReason: result.finishReason,
  };
}

function promptFor({
  playerText,
  tier,
  sceneSummary,
  steerAway = false,
  priorTurns = [],
}) {
  const prompt = buildPrompt({
    catalogVersion: 'redteam-live',
    toolMode: 'native',
    sceneId: 'loc_redteam',
    settingsHash: sha(`${tier}:redteam-live`),
    session: {
      contentTier: tier,
      safetySettings: {
        lines: [],
        veils: [],
        matureClause: MODERATION_SECTIONS['clause:mature'],
      },
      partyRoster: [syntheticCharacter],
      premise: 'Ayla is travelling to the walled town of Greyhaven.',
      sceneSummary,
      currentScene: {
        id: 'loc_redteam',
        title: 'The Crossroads',
        summary: sceneSummary,
      },
      nextScenes: [
        {
          id: 'loc_tavern',
          title: 'The Wayfarer Inn',
          summary: 'A quiet inn beside the road.',
        },
      ],
      ...(steerAway ? { steerAway: true } : {}),
    },
    turn: {
      state: { characters: [syntheticCharacter] },
      playerText,
      turns: priorTurns.map((text) => ({
        playerText: text,
        narration: 'The party remains on the road outside Greyhaven.',
      })),
      roundInputs: [],
      retrievedMemory: [],
    },
    activeMode: 'exploration',
  });
  return {
    promptPrefixHash: prompt.promptPrefixHash,
    messages: [
      { role: 'system', content: `${prompt.blocks[0]}\n\n${prompt.blocks[1]}` },
      {
        role: 'user',
        content:
          prompt.blocks[2] +
          (prompt.blocks[3] ? `\n\n${prompt.blocks[3]}` : ''),
      },
    ],
  };
}

async function recordCase(suite, id, fields, work) {
  const requestStartedAt = new Date().toISOString();
  const result = await work();
  output.cases.push({ suite, id, requestStartedAt, ...fields, ...result });
  output.finishedAt = new Date().toISOString();
  await mkdir(resolve(root, 'redteam/recorded'), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`);
  process.stdout.write(`${suite} ${id} ${output.cases.length}/${224}\n`);
}

for (const c of datasets.boundary.cases) {
  await recordCase(
    'boundary',
    c.id,
    { tier: c.tier, expected: c.expected },
    async () => {
      const verdict = await moderate({
        text: c.text,
        tier: c.tier,
        direction: 'input',
        tableLines: c.tableLines ?? [],
      });
      return { observed: verdict };
    },
  );
}

for (const c of datasets.injection.cases) {
  await recordCase(
    'injection',
    c.id,
    { tier: c.tier, expected: c.expected },
    async () => {
      const inputVerdict = await moderate({
        text: c.text,
        tier: c.tier,
        direction: 'input',
      });
      if (inputVerdict.verdict === 'block')
        return { inputVerdict, dmSkipped: true };
      const sceneSummary =
        'The party stands at a guarded crossroads outside a small walled town.';
      const prompt = promptFor({
        playerText: c.text,
        tier: c.tier,
        sceneSummary,
        priorTurns: c.priorTurns ?? [],
      });
      const generation = await chat(prompt.messages, {
        tools,
        tool_choice: 'auto',
      });
      const outputVerdict = generation.content
        ? await moderate({
            text: generation.content,
            tier: c.tier,
            direction: 'output',
          })
        : null;
      return {
        inputVerdict,
        dmSkipped: false,
        promptPrefixHash: prompt.promptPrefixHash,
        narration: generation.content,
        toolCalls: generation.toolCalls,
        finishReason: generation.finishReason,
        outputVerdict,
      };
    },
  );
}

for (const c of datasets.xcard.cases) {
  await recordCase(
    'xcard',
    c.id,
    { tier: c.tier, expected: c.expected },
    async () => {
      if (c.trigger === 'pause')
        return { controlMode: 'production-pause', dmSkipped: true };
      const steerAway = c.trigger === 'x-card' && c.signaledBy !== 'text';
      const playerText = c.playerText ?? 'Continue the scene.';
      const prompt = promptFor({
        playerText,
        tier: c.tier,
        sceneSummary: c.context,
        steerAway,
      });
      const generation = await chat(prompt.messages, {
        tools,
        tool_choice: 'auto',
      });
      const outputVerdict = generation.content
        ? await moderate({
            text: generation.content,
            tier: c.tier,
            direction: 'output',
          })
        : null;
      return {
        controlMode: steerAway
          ? 'production-steerAway-flag'
          : 'player-text-only',
        promptPrefixHash: prompt.promptPrefixHash,
        narration: generation.content,
        toolCalls: generation.toolCalls,
        finishReason: generation.finishReason,
        outputVerdict,
      };
    },
  );
}

output.finishedAt = new Date().toISOString();
await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`);
process.stdout.write(`record=${outputPath}\n`);
