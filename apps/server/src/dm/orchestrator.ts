import { createHash } from 'node:crypto';
import {
  DMToolArgsSchema,
  DMToolCallSchema,
  DMToolErrorCodeSchema,
  StartCombatEncounterArgsSchema,
  type DMToolErrorCode,
  type DMToolName,
  type DMTurnEvent,
} from '@game/schema';

import type {
  LlmAdapter,
  LlmChunk,
  LlmMessage,
  LlmTool,
  LlmRequest,
} from '../llm/adapter.js';
import { LlmEndpointError, normalizeEndpointError } from '../llm/adapter.js';
import {
  buildPrompt,
  COMBAT_ONLY_TOOLS,
  READ_ONLY_TOOLS,
  zodSchema,
  type BuildPromptInput,
} from './prompt.js';
import { formatTurnSeed, createTurnSeed } from './seed.js';
import {
  runOutputGate,
  SAFE_REDIRECT_TEMPLATE,
  X_CARD_REDIRECT_TEMPLATE,
} from '../safety/outputGate.js';
import type { Moderator } from '../safety/moderator.js';
import type { ContentTier } from '../safety/tier.js';

export const MAX_TOOL_CALLS = 8;
export const MAX_RETRIES_PER_CALL_SITE = 2;
export const MAX_RETRIES_PER_TURN = 5;
export const MAX_RULES_LOOKUPS = 2;
const MODERATION_HOLDING_NOTICE =
  'The narrator pauses while the scene is checked. Try again shortly.';
const POLICY_ERRORS = new Set<DMToolErrorCode>([
  'condition-engine-owned',
  'loot-budget-exceeded',
  'enemy-cap-exceeded',
  'fact-immutable',
  'invalid-scene-transition',
  'dc-out-of-range',
]);
const RECOVERABLE_ERRORS = new Set<DMToolErrorCode>(['not-actors-turn']);
// Only snake_case tool names and hyphenated error codes: plain-English names such as `attack` must not trip the guard.
const META_LEAK_PATTERN = new RegExp(
  `(?:\\b(?:${[
    ...DMToolCallSchema.options.map((o) => o.shape.name.value as string),
    ...DMToolErrorCodeSchema.options,
  ]
    .filter((n) => /[_-]/.test(n))
    .join(
      '|',
    )})\\b|\\btools?\\s+(?:calls?|errors?|results?|requires?|failed|failure|response)\\b|function\\s+call|[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}|\\bent_[a-z0-9_-]+\\b)`,
  'i',
);
// NFKC + zero-width stripping so fullwidth and invisible-character variants cannot slip past the pattern.
const leaksMeta = (text: string): boolean =>
  META_LEAK_PATTERN.test(
    text.normalize('NFKC').replace(/[\u200B-\u200D\u2060\uFEFF\u00AD]/g, ''),
  );
const META_RETRY =
  'Continue in-fiction. Never mention tools, function calls, identifiers, internal rules, or error messages. Give only a brief player-facing narration; if no safe narration is possible, say what happens next neutrally.';
const BUDGET_ERRORS = new Set<DMToolErrorCode>([
  'turn-budget-exhausted',
  'lookup-budget-exhausted',
]);

export interface EngineToolOutput {
  events: readonly unknown[];
  nextState?: unknown;
  rollCount?: number;
}
export interface ToolExecution {
  ok: boolean;
  error?: DMToolErrorCode;
  hint?: string;
  summary?: string;
  events?: readonly string[];
  output?: EngineToolOutput;
  options?: readonly { optionId: string; label: string }[];
}
export interface ToolEngineResult {
  ok: boolean;
  error?: DMToolErrorCode;
  hint?: string;
  summary?: string;
  events: string[];
  value?: unknown;
}
export interface DmToolContext {
  state: unknown;
  engineState: unknown;
  closeScene?: (args: {
    summary: string;
    nextSceneId?: string;
  }) => Promise<ToolExecution> | ToolExecution;
  commitState?: (previous: unknown, output: EngineToolOutput) => unknown;
  seed: number;
  rollIndex: number;
  turnId: string;
  execute?: (
    name: DMToolName,
    args: unknown,
    context: DmToolContext,
  ) => Promise<ToolExecution> | ToolExecution;
  engineExecute?: (
    state: unknown,
    call: unknown,
    seed: number,
  ) => Promise<ToolEngineResult> | ToolEngineResult;
  rulesLookup?: (
    topic: string,
  ) => Promise<
    readonly { sectionPath: string; text: string; srdPage: number }[]
  >;
  emit?: (event: unknown) => void;
}
export interface TurnInput {
  turnId: string;
  /** Table key used to enforce per-session output judge fairness. */
  sessionId?: string;
  turnSeed?: bigint | number | string;
  testMode?: boolean;
  prompt: Omit<BuildPromptInput, 'turn'> & { turn: BuildPromptInput['turn'] };
  context: DmToolContext;
  adapter: LlmAdapter;
  toolMode: 'native' | 'json-schema';
  toolSchemas?: Readonly<Record<string, unknown>>;
  toolDescriptions?: Partial<Record<DMToolName, string>>;
  emit?: (event: DMTurnEvent | unknown) => void;
  stream?: (event: DMTurnEvent) => void;
  signal?: AbortSignal;
  eventSeqStart?: number;
  modelId?: string;
  /** No narration event or transcript value may bypass this moderator. */
  outputModerator: Moderator;
  outputTier: ContentTier;
  outputTableLines?: readonly string[];
  allowClarification?: boolean;
  clarificationAsked?: boolean;
}
export interface TurnResult {
  narration: string;
  events: readonly unknown[];
  state: unknown;
  turnSeed: string;
  usage: { in: number; out: number; cacheRead?: number };
  fallback?: 'no-narration' | 'endpoint-error' | 'budget-exhausted';
  clarification?: { actionId: string; question: string };
}

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const callHash = (name: string, args: unknown) =>
  sha(`${name}\n${canonical(args)}`);
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
function words(text: string): number {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}
function truncateAtSentence(text: string, limit: number): string {
  const tokens = text.trim().split(/\s+/);
  if (tokens.length <= limit) return text.trim();
  const prefix = tokens.slice(0, limit).join(' ');
  const sentenceEnds = [...prefix.matchAll(/[.!?](?:["'”’)]*)?(?=\s|$)/g)];
  const end = sentenceEnds.at(-1)?.index;
  return (end === undefined ? prefix : prefix.slice(0, end + 1)).trim();
}
async function gateOneShotOutput(
  text: string,
  moderator: Moderator,
  tier: ContentTier,
  tableLines?: readonly string[],
  sessionId?: string,
): Promise<{ text: string; unavailable: boolean; approved: boolean }> {
  const gate = runOutputGate({
    stream: async function* () {
      yield text;
    },
    regenerate: async function* () {},
    moderator,
    tier,
    tableLines,
    sessionId,
    maxRegenerations: 0,
  });
  let approvedText = '';
  let redirected = false;
  let unavailable = false;
  for await (const event of gate) {
    if (event.kind === 'chunk') approvedText += event.text;
    if (event.kind === 'end') {
      redirected = event.outcome === 'redirected';
      unavailable = event.metrics.chunks.some(
        (chunk) => chunk.source === 'failclosed',
      );
    }
  }
  return {
    text: redirected
      ? unavailable
        ? MODERATION_HOLDING_NOTICE
        : SAFE_REDIRECT_TEMPLATE
      : approvedText,
    unavailable,
    approved: !redirected,
  };
}
function toolSchemas(input: TurnInput): LlmTool[] {
  return DMToolCallSchema.options.flatMap((option) => {
    const name = option.shape.name.value;
    if (name === 'ask_clarification' && !canAskClarification(input)) return [];
    if (input.prompt.readOnlyTools && !READ_ONLY_TOOLS.includes(name))
      return [];
    if (
      name === 'start_combat' &&
      (input.prompt.activeMode === 'combat' ||
        !input.prompt.offeredEncounterKeys?.length)
    )
      return [];
    return [
      {
        name,
        description:
          input.toolDescriptions?.[name] ??
          (name === 'start_combat'
            ? 'Start the offered authored encounter for this scene when the accepted player action initiates hostility, before narrating any combat outcome. Pass the exact offered encounterId; the server supplies the roster and map. Never invent enemies or resolve attacks in narration. On success narrate the engine-established encounter start; on rejection do not claim combat began.'
            : `Validated ${name} action.`),
        // Native tool calling needs real JSON schemas; empty parameters made models emit {} args.
        parameters: (input.toolSchemas?.[name] ??
          zodSchema(toolArgsSchema(input, name))) as Record<string, unknown>,
      },
    ];
  });
}
function toolArgsSchema(input: TurnInput, name: string) {
  if (
    name === 'start_combat' &&
    input.prompt.activeMode !== 'combat' &&
    input.prompt.offeredEncounterKeys?.length
  )
    return StartCombatEncounterArgsSchema;
  return DMToolArgsSchema[name as keyof typeof DMToolArgsSchema];
}
function canAskClarification(input: TurnInput): boolean {
  return (
    input.allowClarification === true &&
    input.clarificationAsked !== true &&
    !input.prompt.readOnlyTools
  );
}
function safeArgs(
  name: string,
  args: unknown,
  input: TurnInput,
):
  | { success: true; value: unknown }
  | { success: false; hint: string; error: DMToolErrorCode } {
  if (!Object.hasOwn(DMToolArgsSchema, name))
    return {
      success: false,
      error: 'unknown-tool',
      hint: 'Use a tool from the supplied tool list.',
    };
  const schema = toolArgsSchema(input, name);
  const parsed = schema.safeParse(args);
  if (!parsed.success)
    return {
      success: false,
      error: 'schema-violation',
      hint: parsed.error.issues
        .slice(0, 3)
        .map((issue) => issue.message)
        .join('; '),
    };
  return { success: true, value: parsed.data };
}

async function executeTool(
  name: DMToolName,
  args: unknown,
  context: DmToolContext,
): Promise<ToolExecution> {
  if (name === 'close_scene') {
    if (!context.closeScene)
      return {
        ok: false,
        error: 'unknown-tool',
        hint: 'Scene closing is unavailable outside an active solo adventure.',
      };
    return await context.closeScene(
      args as { summary: string; nextSceneId?: string },
    );
  }
  if (context.execute) return context.execute(name, args, context);
  if (name === 'rules_lookup') {
    if (!context.rulesLookup)
      return {
        ok: false,
        error: 'unknown-tool',
        hint: 'Rules lookup is unavailable; continue without it.',
      };
    const results = await context.rulesLookup(
      (args as { topic: string }).topic,
    );
    return {
      ok: true,
      summary: results
        .map((r) => `${r.sectionPath} (SRD p. ${r.srdPage}): ${r.text}`)
        .join(' ')
        .slice(0, 200),
      events: [],
      options: [],
    };
  }
  if (
    ![
      'request_check',
      'request_save',
      'attack',
      'cast_spell',
      'apply_condition',
      'remove_condition',
      'start_combat',
      'end_combat',
      'call_for_rest',
      'move_to',
      'suggest_area_target',
      'upsert_npc',
      'upsert_location',
      'update_quest',
      'set_flag',
      'log_ruling',
    ].includes(name)
  ) {
    return {
      ok: false,
      error: 'unknown-tool',
      hint: 'This domain tool is not configured for this session.',
    };
  }
  if (!context.engineExecute)
    return {
      ok: false,
      error: 'unknown-tool',
      hint: 'Engine tool executor is unavailable.',
    };
  const raw = await context.engineExecute(
    context.engineState,
    { name, args },
    context.seed,
  );
  if (!raw.ok) return { ok: false, error: raw.error, hint: raw.hint };
  const value = raw.value as
    | { events?: unknown[]; rng?: number; state?: unknown }
    | undefined;

  return {
    ok: true,
    summary: raw.summary,
    events: raw.events,
    options:
      value && 'options' in value
        ? (value.options as ToolExecution['options'])
        : undefined,
    output: {
      events: value?.events ?? [],
      nextState: value?.state,
      rollCount: raw.events.filter((event) => event === 'RollEvent').length,
    },
  };
}

/** Per-table FIFO: generation for one turn completes before the next starts. */
export class TurnQueue {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work);
    this.tail = result.catch(() => undefined);
    return result;
  }
}

const tableQueues = new Map<string, TurnQueue>();
export function runTurnQueued(
  tableId: string,
  input: TurnInput,
): Promise<TurnResult> {
  let queue = tableQueues.get(tableId);
  if (!queue) {
    queue = new TurnQueue();
    tableQueues.set(tableId, queue);
  }
  return queue.run(() => runTurn({ ...input, sessionId: tableId }));
}

/** Executes one serialized DM turn. State changes enter only through validated tool outputs. */
export async function runTurn(input: TurnInput): Promise<TurnResult> {
  const turnSeed =
    input.turnSeed === undefined
      ? createTurnSeed({ testMode: input.testMode })
      : createTurnSeed({ testMode: input.testMode, fixedSeed: input.turnSeed });
  const seedText = formatTurnSeed(turnSeed);
  const prompt = buildPrompt({
    ...input.prompt,
    toolSchemas: input.toolSchemas,
  });
  const emit = (event: DMTurnEvent | unknown) => {
    input.emit?.(event);
    input.context.emit?.(event);
  };
  const stream = (event: DMTurnEvent) => {
    input.stream?.(event);
    emit(event);
  };
  const turnInputs = [
    {
      playerId: 'current-player',
      actionId: input.turnId,
      text: input.prompt.turn.playerText,
    },
  ];
  const events: unknown[] = [];
  const append = (event: unknown) => {
    events.push(event);
  };
  const emitEngine = (event: unknown) => {
    append(event);
    emit(event);
  };
  emit({
    type: 'TurnStarted',
    turnId: input.turnId,
    seed: seedText,
    promptPrefixHash: prompt.promptPrefixHash,
    inputs: turnInputs,
  });
  if (prompt.overBudget)
    emit({
      type: 'PromptOverBudget',
      turnId: input.turnId,
      tokens: prompt.tokens,
      trimsApplied: prompt.trimsApplied,
    });
  const messages: LlmMessage[] = [
    { role: 'system', content: prompt.blocks[0] + '\n\n' + prompt.blocks[1] },
    {
      role: 'user',
      content:
        prompt.blocks[2] + (prompt.blocks[3] ? `\n\n${prompt.blocks[3]}` : ''),
    },
  ];
  const attempts = new Map<string, number>();
  let retries = 0,
    toolCalls = 0,
    rulesLookups = 0,
    rollIndex = 0,
    totalIn = 0,
    totalOut = 0,
    cacheRead = 0;
  let finalText = '',
    fallback: TurnResult['fallback'],
    finalCut = false,
    sceneClosed = false;
  const callCapHits = new Set<string>();
  const toolObservations: {
    name: string;
    argKeys: string[];
    outcome: string;
  }[] = [];
  let hadToolError = false;
  let usedFinalText = false;
  let endpointFailed = false;
  const turnStartState = structuredClone(input.context.state);
  const cloneEngineState = (value: unknown) => {
    if (!value || typeof value !== 'object' || !('catalog' in value))
      return structuredClone(value);
    const { catalog: engineCatalog, ...cloneable } = value as Record<
      string,
      unknown
    >;
    return { ...structuredClone(cloneable), catalog: engineCatalog };
  };
  const turnStartEngineState = cloneEngineState(input.context.engineState);
  let clarification: TurnResult['clarification'];
  const makeFallback = (reason: NonNullable<TurnResult['fallback']>) => {
    fallback = reason;
    emit({ type: 'TurnFallback', turnId: input.turnId, reason });
    finalText =
      reason === 'endpoint-error'
        ? 'The tale pauses — the storyteller has lost the thread. Your action was not resolved; try again.'
        : events.some(
              (event) =>
                (event as { type?: string }).type === 'RollEvent' ||
                (event as { type?: string }).type === 'HpChanged' ||
                (event as { type?: string }).type === 'EntityMoved',
            )
          ? 'The dice have spoken — the results stand above. The scene holds for a moment. What do you do?'
          : 'Nothing comes of the attempt. What do you do?';
  };
  let done = false;
  try {
    if (input.signal?.aborted)
      throw new LlmEndpointError('stream-aborted', 'LLM request was aborted');
    if (input.prompt.session.steerAway) {
      // The control is authoritative: do not expose prior-scene context to the model
      // or allow a generated tool call to mutate state on the redirect turn.
      finalText = X_CARD_REDIRECT_TEMPLATE;
      done = true;
    }
    for (let requestIndex = 0; requestIndex < 32 && !done; requestIndex++) {
      if (input.signal?.aborted)
        throw new LlmEndpointError('stream-aborted', 'LLM request was aborted');
      const textDeltas: string[] = [],
        calls: Extract<LlmChunk, { type: 'tool-call' }>[] = [];
      let requestOut = 0;
      const request: LlmRequest = {
        messages: [...messages],
        maxTokens: toolCalls > 0 ? 400 : 512,
        toolMode: input.toolMode,
        tools: toolSchemas(input),
        signal: input.signal,
        cacheHints: { stablePrefixMessages: 1 },
      };
      try {
        for await (const chunk of input.adapter.complete(request)) {
          if (chunk.type === 'usage') {
            totalIn += chunk.usage.input;
            totalOut += chunk.usage.output;
            requestOut += chunk.usage.output;
            cacheRead += chunk.usage.cacheRead ?? 0;
          } else if (chunk.type === 'text') textDeltas.push(chunk.delta);
          else calls.push(chunk);
        }
      } catch (error) {
        const normalized = normalizeEndpointError(error);
        if (normalized.code === 'stream-aborted' && input.signal?.aborted)
          throw normalized;
        endpointFailed = true;
        makeFallback('endpoint-error');
        done = true;
        break;
      }
      if (calls.length === 0) {
        finalText = textDeltas.join('');
        usedFinalText = !!finalText;
        finalCut = requestOut >= request.maxTokens;
        done = true;
        break;
      }
      messages.push({
        role: 'assistant',
        content: textDeltas.join(''),
        toolCalls: calls.map((call) => ({
          id: call.id,
          name: call.name,
          arguments: call.arguments,
        })),
      });
      // Any prose co-emitted with calls is intentionally discarded.
      for (const call of calls) {
        const validated = safeArgs(call.name, call.arguments, input);
        const callSite = `${call.name}:${callHash(call.name, validated.success ? validated.value : call.arguments)}`;
        const attempt = (attempts.get(callSite) ?? 0) + 1;
        const reject = (
          code: DMToolErrorCode,
          hint: string,
          terminal = false,
        ) => {
          const argHash = callHash(call.name, call.arguments);
          toolObservations.push({
            name: call.name,
            argKeys: Object.keys(
              call.arguments && typeof call.arguments === 'object'
                ? (call.arguments as object)
                : {},
            ),
            outcome: code,
          });
          hadToolError = true;
          emit({
            type: 'ToolCallRejected',
            turnId: input.turnId,
            toolName: call.name,
            error: code,
            attempt,
            argHash,
          });
          const result = {
            ok: false,
            error: code,
            hint,
            ...(terminal ? { terminal: true } : {}),
          };
          messages.push({
            role: 'tool',
            name: call.name,
            toolCallId: call.id,
            content: JSON.stringify(result),
          });
          return result;
        };
        if (
          call.name !== 'rules_lookup' &&
          call.name !== 'suggest_area_target' &&
          toolCalls >= MAX_TOOL_CALLS
        ) {
          reject(
            'turn-budget-exhausted',
            'This turn has reached its tool-call limit. Narrate the established results; do not call another tool.',
            true,
          );
          makeFallback('budget-exhausted');
          done = true;
          break;
        }
        if (call.name === 'rules_lookup' && rulesLookups >= MAX_RULES_LOOKUPS) {
          reject(
            'lookup-budget-exhausted',
            'Rules lookup budget is exhausted. Continue without another lookup.',
            true,
          );
          continue;
        }
        if (!validated.success) {
          attempts.set(callSite, attempt);
          retries++;
          const terminal = POLICY_ERRORS.has(validated.error)
            ? attempt > 2
            : attempt > MAX_RETRIES_PER_CALL_SITE ||
              retries > MAX_RETRIES_PER_TURN;
          reject(validated.error, validated.hint, terminal);
          if (terminal) callCapHits.add(callSite);
          if (retries >= MAX_RETRIES_PER_TURN) {
            makeFallback('budget-exhausted');
            done = true;
            break;
          }
          continue;
        }
        attempts.set(callSite, attempt);
        if (
          input.prompt.readOnlyTools &&
          !READ_ONLY_TOOLS.includes(call.name)
        ) {
          // ADR-034 §2.2: the engine already applied the mechanics; a mutating call is refused, never executed.
          reject('unknown-tool', 'Only read-only tools exist while narrating.');
          retries++;
          if (retries >= MAX_RETRIES_PER_TURN) {
            makeFallback('budget-exhausted');
            done = true;
            break;
          }
          continue;
        }
        if (call.name === 'ask_clarification') {
          if (!input.allowClarification) {
            reject(
              'unknown-tool',
              'Clarifying questions are unavailable for this turn.',
            );
            continue;
          }
          if (input.clarificationAsked) {
            reject(
              'clarification-already-asked',
              'A clarifying question was already asked for this action; decide and narrate.',
            );
            continue;
          }
          const args = validated.value as {
            actionId: string;
            question: string;
          };
          if (args.actionId !== input.turnId) {
            reject('malformed-ref', `Use actionId ${input.turnId}.`);
            continue;
          }
          clarification = { actionId: input.turnId, question: args.question };
          done = true;
          break;
        }
        if (
          (input.prompt.activeMode !== 'combat' &&
            COMBAT_ONLY_TOOLS.includes(call.name)) ||
          (input.prompt.activeMode === 'combat' && call.name === 'start_combat')
        ) {
          reject(
            'unknown-tool',
            'This tool is unavailable in the current mode.',
          );
          retries++;
          if (retries >= MAX_RETRIES_PER_TURN) {
            makeFallback('budget-exhausted');
            done = true;
            break;
          }
          continue;
        }
        if (call.name !== 'suggest_area_target' && call.name !== 'rules_lookup')
          toolCalls++;
        else if (call.name === 'rules_lookup') rulesLookups++;
        if (call.name === 'close_scene' && sceneClosed) {
          reject(
            'scene-already-closed',
            'The scene was already closed this turn; narrate the outcome.',
            true,
          );
          continue;
        }
        const outcome = await executeTool(
          call.name as DMToolName,
          validated.value,
          {
            ...input.context,
            seed: Number((turnSeed ^ BigInt(rollIndex)) & 0xffffffffn),
            rollIndex,
            turnId: input.turnId,
            emit: emitEngine,
          },
        );
        if (!outcome.ok) {
          const code = outcome.error ?? 'schema-violation';
          toolObservations.push({
            name: call.name,
            argKeys: Object.keys(validated.value as object),
            outcome: code,
          });
          hadToolError = true;
          if (RECOVERABLE_ERRORS.has(code)) {
            // ponytail: an out-of-turn call never executed, so it must not spend the turn's tool-call cap.
            toolCalls--;
            reject(code, outcome.hint ?? 'Choose a legal alternative.');
            continue;
          }
          retries++;
          const cap = POLICY_ERRORS.has(code)
            ? attempt > 1
            : attempt > MAX_RETRIES_PER_CALL_SITE ||
              retries > MAX_RETRIES_PER_TURN;
          const terminal = cap || BUDGET_ERRORS.has(code);
          reject(code, outcome.hint ?? 'Choose a legal alternative.', terminal);
          if (terminal) callCapHits.add(callSite);
          if (retries >= MAX_RETRIES_PER_TURN) {
            makeFallback('budget-exhausted');
            done = true;
            break;
          }
          continue;
        }
        toolObservations.push({
          name: call.name,
          argKeys: Object.keys(validated.value as object),
          outcome: 'ok',
        });
        if (call.name === 'close_scene') sceneClosed = true;
        const toolResult = {
          ok: true,
          events: [...(outcome.events ?? [])],
          summary: (outcome.summary ?? 'The action resolved.').slice(0, 200),
          ...(outcome.options ? { options: outcome.options } : {}),
        };
        if (outcome.output?.nextState !== undefined)
          input.context.engineState = outcome.output.nextState;
        if (
          outcome.output?.nextState !== undefined &&
          input.context.commitState
        )
          input.context.state = input.context.commitState(
            input.context.state,
            outcome.output,
          );
        for (const event of outcome.output?.events ?? []) emitEngine(event);
        rollIndex +=
          outcome.output?.rollCount ??
          (outcome.events ?? []).filter((event) => event === 'RollEvent')
            .length;
        messages.push({
          role: 'tool',
          name: call.name,
          toolCallId: call.id,
          content: JSON.stringify(toolResult),
        });
      }
      if (callCapHits.size && retries >= MAX_RETRIES_PER_TURN) {
        // A final request is allowed after terminal results, unless a hard budget was hit.
        messages.push({
          role: 'user',
          content:
            'Some tool calls are terminal. Do not repeat them; narrate the outcome.',
        });
      }
    }
    if (!done && !finalText && !fallback) makeFallback('no-narration');
  } catch (error) {
    if (input.signal?.aborted) throw error;
    const normalized = normalizeEndpointError(error);
    if (normalized instanceof LlmEndpointError) {
      endpointFailed = true;
      makeFallback('endpoint-error');
    } else throw error;
  }
  if (clarification) {
    const gatedQuestion = await gateOneShotOutput(
      clarification.question,
      input.outputModerator,
      input.outputTier,
      input.outputTableLines,
      input.sessionId,
    );
    if (gatedQuestion.approved) {
      emit({
        type: 'ClarificationRequested',
        actionId: clarification.actionId,
        question: gatedQuestion.text,
      });
    } else {
      emit({
        type: 'NarrationChunk',
        turnId: input.turnId,
        text: gatedQuestion.text,
        index: 0,
        ...(gatedQuestion.unavailable ? { moderationHeld: true } : {}),
      });
      emit({
        type: 'NarrationCompleted',
        turnId: input.turnId,
        text: gatedQuestion.text,
        words: words(gatedQuestion.text),
        ...(gatedQuestion.unavailable ? { moderationHeld: true } : {}),
      });
    }
    return {
      narration: gatedQuestion.text,
      events: [],
      state: input.prompt.turn.state,
      turnSeed: seedText,
      usage: {
        in: totalIn,
        out: totalOut,
        ...(cacheRead ? { cacheRead } : {}),
      },
      ...(gatedQuestion.approved ? { clarification } : {}),
    };
  }
  if (hadToolError) messages.push({ role: 'user', content: META_RETRY });
  if (!finalText || leaksMeta(finalText)) {
    const wasEmpty = !finalText;
    // One bounded, tool-free repair attempt; never expose reasoning or tool diagnostics.
    try {
      let repaired = '';
      for await (const chunk of input.adapter.complete({
        messages: hadToolError
          ? messages
          : [...messages, { role: 'user', content: META_RETRY }],
        maxTokens: 256,
        toolMode: input.toolMode,
        tools: [],
        signal: input.signal,
      }))
        if (chunk.type === 'text') repaired += chunk.delta;
      finalText =
        repaired && !leaksMeta(repaired) ? repaired : SAFE_REDIRECT_TEMPLATE;
      usedFinalText = !!repaired && finalText === repaired;
      if (wasEmpty && !repaired) fallback = 'no-narration';
    } catch (error) {
      if (input.signal?.aborted) throw error;
      finalText = SAFE_REDIRECT_TEMPLATE;
      if (wasEmpty) fallback = 'no-narration';
    }
  }
  console.info(
    JSON.stringify({
      event: 'dm_turn_observability',
      sessionIdHash: input.sessionId
        ? createHash('sha256').update(input.sessionId).digest('hex')
        : null,
      turnId: input.turnId,
      toolsOffered: toolSchemas(input).map((tool) => tool.name),
      toolCalls: toolObservations,
      activeMode: input.prompt.activeMode,
      sceneId: input.prompt.sceneId,
      narrationSource: usedFinalText ? 'final-text' : 'fallback',
    }),
  );
  const finalWords = words(finalText);
  const keepWords = Math.max(
    0,
    Math.min(finalCut ? finalWords - 1 : finalWords, 300),
  );
  if (keepWords < finalWords) {
    finalText = truncateAtSentence(finalText, keepWords);
    emit({
      type: 'NarrationTruncated',
      turnId: input.turnId,
      words: finalWords,
    });
  }
  if (!finalText) makeFallback(fallback ?? 'no-narration');
  let finalCount = words(finalText);
  if (endpointFailed) {
    // Endpoint failure invalidates the in-flight turn; state is committed by the caller only on success.
    events.length = 0;
    input.context.state = structuredClone(turnStartState);
    input.context.engineState = cloneEngineState(turnStartEngineState);
  }
  const sourceText = finalText;
  const gated: string[] = [];
  const chunks = async function* () {
    const chunkSize = 24;
    for (let offset = 0; offset < sourceText.length; offset += chunkSize)
      yield sourceText.slice(offset, offset + chunkSize);
  };
  const gate = runOutputGate({
    stream: () => chunks(),
    // This turn has already executed tools. Retrying its model call could repeat side effects;
    // on any block, stop and use the gate's authored redirect instead.
    regenerate: async function* () {},
    moderator: input.outputModerator,
    tier: input.outputTier,
    tableLines: input.outputTableLines,
    sessionId: input.sessionId,
    maxRegenerations: 0,
  });
  // Never persist the original model text.
  let index = 0;
  let gateOutcome: 'approved' | 'redirected' | undefined;
  let gateHadUnavailableVerdict = false;
  for await (const event of gate) {
    if (event.kind === 'chunk') {
      // Hold the entire narration until every chunk has a verdict. Otherwise a later
      // classifier outage could leave already-approved partial text in the transcript.
      gated.push(event.text);
    } else if (event.kind === 'end') {
      gateOutcome = event.outcome;
      gateHadUnavailableVerdict = event.metrics.chunks.some(
        (chunk) => chunk.source === 'failclosed',
      );
    }
  }
  finalText =
    gateOutcome === 'redirected'
      ? gateHadUnavailableVerdict
        ? MODERATION_HOLDING_NOTICE
        : SAFE_REDIRECT_TEMPLATE
      : gated.join('');
  if (finalText) {
    stream({
      type: 'NarrationChunk',
      turnId: input.turnId,
      text: finalText,
      index: index++,
      ...(gateOutcome === 'redirected' && gateHadUnavailableVerdict
        ? { moderationHeld: true }
        : {}),
    });
  }
  finalCount = words(finalText);
  emit({
    type: 'NarrationCompleted',
    turnId: input.turnId,
    text: finalText,
    words: finalCount,
    ...(gateOutcome === 'redirected' && gateHadUnavailableVerdict
      ? { moderationHeld: true }
      : {}),
    ...(fallback ? { fallback } : {}),
  });
  const inSeq = input.eventSeqStart ?? 0;
  emit({
    type: 'TurnCommitted',
    turnId: input.turnId,
    eventSeqRange: [inSeq, inSeq + events.length],
    usage: { in: totalIn, out: totalOut, ...(cacheRead ? { cacheRead } : {}) },
  });
  return {
    narration: finalText,
    events,
    state: input.context.state,
    turnSeed: seedText,
    usage: { in: totalIn, out: totalOut, ...(cacheRead ? { cacheRead } : {}) },
    ...(fallback ? { fallback } : {}),
  };
}
