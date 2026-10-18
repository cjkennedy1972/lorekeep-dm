import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkLiveUrl } from '../dist/live.js';
import { generateWithBuiltPrompt } from '../redteam/prompt-messages.mjs';
import {
  assertNoSecretParts,
  assertPinnedHost,
} from '../redteam/endpoint-pin.mjs';
import { DMToolArgsSchema } from '../../../packages/schema/dist/dm-tools.js';
import { buildPrompt, zodSchema } from '../../../apps/server/dist/dm/prompt.js';
import {
  buildJudgeMessages,
  parseVerdictReply,
} from '../../../apps/server/dist/safety/moderator.js';
import { MODERATION_SECTIONS } from '../../../apps/server/dist/safety/moderationRubric.generated.js';
import { checkHardFloor } from '../../../apps/server/dist/safety/hardFloor.js';
import { hardFloorLayer } from '../../../apps/server/dist/safety/deterministicLayer.js';
import { runTurn } from '../../../apps/server/dist/dm/orchestrator.js';
import {
  SAFE_REDIRECT_TEMPLATE,
  X_CARD_REDIRECT_TEMPLATE,
} from '../../../apps/server/dist/safety/outputGate.js';

const baseUrl = process.env.REDTEAM_BASE_URL;
if (!baseUrl) throw new Error('REDTEAM_BASE_URL is required');
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
assertNoSecretParts(endpointUrl);
assertPinnedHost(endpointUrl.host, process.env.REDTEAM_EXPECTED_HOST);
const RETRYABLE_HTTP_STATUSES = new Set([400, 429]);
const HTTP_RETRY_DELAY_MS = 250;

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const load = async (name) =>
  JSON.parse(await readFile(resolve(root, 'redteam', name), 'utf8'));
const datasets = {
  injection: await load('injection-100.json'),
  boundary: await load('boundary-100.json'),
  xcard: await load('xcard-redirect.json'),
};
const startedAt = new Date().toISOString();
const runStamp = startedAt.replace(/[:.]/g, '-');
const outputPath = resolve(
  root,
  `redteam/recorded/live-qwen3.8-35b-a3b-distill-q4-${runStamp}.json`,
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
  endpoint: {
    profile,
    baseUrl: endpointUrl.origin + endpointUrl.pathname,
    model,
  },
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
      'Authoritative steer-away control cases call the production runTurn orchestrator with an adapter that fails the case if invoked; the authored redirect passes through the production output gate. Text-only control claims remain live-model probes. No game state is persisted.',
    outputModeration:
      'Model-generated narration and authored steer-away redirects are passed through the production moderation rubric in output direction. This harness records verdicts but does not emit narration to a player.',
    retryPolicy:
      'At most one retry is made after HTTP 400, 429, or 5xx responses; the case records the total retry count.',
  },
  cases: [],
};

async function chat(messages, extra = {}) {
  const body = JSON.stringify({
    model,
    temperature: 0,
    max_tokens: 512,
    messages,
    ...extra,
  });
  let retryCount = 0;
  let response;
  for (;;) {
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      redirect: 'error',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body,
      signal: AbortSignal.timeout(120_000),
    });
    if (response.ok) break;
    const retryable =
      RETRYABLE_HTTP_STATUSES.has(response.status) || response.status >= 500;
    if (!retryable || retryCount > 0)
      throw new Error(`endpoint returned HTTP ${response.status}`);
    await response.arrayBuffer();
    retryCount++;
    await new Promise((resolve) => setTimeout(resolve, HTTP_RETRY_DELAY_MS));
  }
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
    retryCount,
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
    retryCount: result.retryCount,
  };
}

function turnInputFor({
  playerText,
  tier,
  sceneSummary,
  steerAway = false,
  priorTurns = [],
}) {
  return {
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
  };
}

function promptFor(input) {
  const prompt = buildPrompt(turnInputFor(input));
  return {
    promptPrefixHash: prompt.promptPrefixHash,
    blocks: prompt.blocks,
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
        return {
          inputVerdict,
          dmSkipped: true,
          requestRetries: inputVerdict.retryCount ?? 0,
        };
      const sceneSummary =
        'The party stands at a guarded crossroads outside a small walled town.';
      const prompt = promptFor({
        playerText: c.text,
        tier: c.tier,
        sceneSummary,
        priorTurns: c.priorTurns ?? [],
      });
      const generation = await generateWithBuiltPrompt(prompt, chat, {
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
        requestRetries:
          (inputVerdict.retryCount ?? 0) +
          generation.retryCount +
          (outputVerdict?.retryCount ?? 0),
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
      const promptInput = turnInputFor({
        playerText,
        tier: c.tier,
        sceneSummary: c.context,
        steerAway,
      });
      const prompt = buildPrompt(promptInput);
      if (steerAway) {
        const events = [];
        const outputVerdicts = [];
        const stateBefore = { characters: [syntheticCharacter] };
        const engineState = {};
        let modelCalls = 0;
        const noCallAdapter = {
          capabilities: () => ({
            streaming: true,
            nativeTools: true,
            jsonSchema: true,
          }),
          probe: async () => true,
          // eslint-disable-next-line require-yield -- generator so the throw happens on iteration
          async *complete() {
            modelCalls++;
            throw new Error(
              'authoritative X-card steer unexpectedly called the model',
            );
          },
        };
        const result = await runTurn({
          turnId: c.id,
          turnSeed: 0,
          testMode: true,
          prompt: promptInput,
          context: {
            state: stateBefore,
            engineState,
            seed: 0,
            rollIndex: 0,
            turnId: c.id,
          },
          adapter: noCallAdapter,
          toolMode: 'native',
          outputModerator: {
            async moderate(request) {
              const verdict = await moderate({
                text: request.text,
                tier: request.tier,
                direction: 'output',
                tableLines: request.tableLines ?? [],
              });
              outputVerdicts.push(verdict);
              return {
                verdict: verdict.verdict,
                category: verdict.category,
                source:
                  verdict.source === 'judge'
                    ? 'judge'
                    : verdict.source === 'denylist'
                      ? 'denylist'
                      : verdict.source === 'hardfloor'
                        ? 'hardfloor'
                        : 'failclosed',
                latencyMs: 0,
                unavailable: verdict.unavailable,
                ...(verdict.unavailable ? { failClosedRow: 'tier' } : {}),
              };
            },
          },
          outputTier: c.tier,
          emit: (event) => events.push(event),
        });
        if (modelCalls !== 0)
          throw new Error('authoritative X-card steer called the model');
        const generated = events.find(
          (event) => event.type === 'NarrationCompleted',
        );
        const outputUnavailable = outputVerdicts.some(
          (verdict) => verdict.unavailable,
        );
        const outputAllowed =
          outputVerdicts.length > 0 &&
          outputVerdicts.every((verdict) => verdict.verdict === 'allow');
        const finalNarration = generated?.text ?? result.narration;
        return {
          controlMode: 'production-steerAway-runTurn',
          promptPrefixHash: prompt.promptPrefixHash,
          narration: finalNarration,
          toolCalls: [],
          modelCalls,
          finishReason: 'deterministic-no-model-call',
          outputVerdict: {
            verdict: outputAllowed ? 'allow' : 'block',
            category: outputVerdicts.at(-1)?.category ?? 'other',
            source: outputVerdicts.at(-1)?.source ?? 'failclosed',
            unavailable: outputUnavailable,
          },
          outputVerdicts,
          requestRetries: outputVerdicts.reduce(
            (total, verdict) => total + (verdict.retryCount ?? 0),
            0,
          ),
          engineEvents: result.events,
          redirectTemplateUsed:
            finalNarration === X_CARD_REDIRECT_TEMPLATE ||
            finalNarration === SAFE_REDIRECT_TEMPLATE,
          stateChanged:
            result.state !== stateBefore || Object.keys(engineState).length > 0,
        };
      }
      const generation = await generateWithBuiltPrompt(prompt, chat, {
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
        requestRetries:
          generation.retryCount + (outputVerdict?.retryCount ?? 0),
      };
    },
  );
}

output.finishedAt = new Date().toISOString();
await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`);
process.stdout.write(`record=${outputPath}\n`);
