// Live-model Adventure #1 transcript. Not in CI: runs only with LIVE_LLM=1 and a DATABASE_URL.
// Credential is read from LLM_API_KEY only; it is never written to the transcript.
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { expect, it } from 'vitest';
import { quickBuild, validateCharacter } from '@game/rules-engine';
import { loadCatalog } from '@game/rules-engine/catalog-node';
import adventure01 from '../../../../packages/engine/adventures/01/adventure.json' with { type: 'json' };
import type {
  LlmAdapter,
  LlmChunk,
  LlmRequest,
} from '../../src/llm/adapter.js';
import { createEndpointEgress } from '../../src/llm/config.js';
import { OpenAICompatibleAdapter } from '../../src/llm/dialects/openai.js';
import { Secret } from '../../src/llm/secret.js';
import { ProductionSoloTurnRunner } from '../../src/room/productionTurnRunner.js';

const BASE_URL = 'http://172.31.25.75:8080/v1';
const MODEL = 'qwen3.8-35b-a3b-distill-q4';
const ADVENTURE = 'adventure:01-hollow-under-marrowfell';
const START_SCENE = 'scene-marowfell-well';
const MAX_MODEL_CALLS = 60;
const ENDPOINT_TIMEOUT_MS = 180_000;
const OUT_PATH = fileURLToPath(
  new URL(
    '../../../../docs/plan/evidence/m2-live-adventure-qwen.md',
    import.meta.url,
  ),
);
const PROMPTS = [
  { id: 'look', text: 'I look around the well. What do I see here?' },
  {
    id: 'talk',
    text: 'I walk up to the hooded figure beside the well and ask what happened to the village.',
  },
  {
    id: 'check',
    text: 'I search the stonework for a hidden inscription. Please call for a Perception check.',
  },
  {
    id: 'descend',
    text: 'I lower myself down into the well shaft and listen for anything below.',
  },
  { id: 'close-1', text: "We are done here. Let's move on to the next place." },
  {
    id: 'gatehouse',
    text: 'I look around the broken gatehouse. Who or what is here?',
  },
  {
    id: 'ghost',
    text: "I ask the gatekeeper's ghost about the bell in the chapel.",
  },
  { id: 'close-2', text: 'We are done here, move on.' },
];

type CallRecord = {
  turn: number;
  kind: 'dm' | 'summary';
  maxTokens: number;
  inputTokens: number;
  outputTokens: number;
  ttftMs: number | null;
  latencyMs: number;
  textChars: number;
  toolCalls: { name: string; args: unknown }[];
  narrationForReview: string;
  errorCode?: string;
};

// Wraps the real OpenAI-compatible adapter to record per-call facts. It does not alter output
// unless LIVE_MAX_TOKENS is set (a floor on maxTokens, disclosed in the transcript header).
class Recording implements LlmAdapter {
  currentTurn = 0;
  readonly calls: CallRecord[] = [];
  constructor(
    private readonly inner: LlmAdapter,
    private readonly maxTokensFloor?: number,
  ) {}
  capabilities() {
    return this.inner.capabilities();
  }
  probe(signal?: AbortSignal) {
    return this.inner.probe(signal);
  }
  async *complete(request: LlmRequest): AsyncIterable<LlmChunk> {
    if (this.calls.length >= MAX_MODEL_CALLS)
      throw new Error('model call budget exhausted');
    const effective = this.maxTokensFloor
      ? {
          ...request,
          maxTokens: Math.max(request.maxTokens, this.maxTokensFloor),
        }
      : request;
    const record: CallRecord = {
      turn: this.currentTurn,
      kind: request.tools?.length ? 'dm' : 'summary',
      maxTokens: effective.maxTokens,
      inputTokens: 0,
      outputTokens: 0,
      ttftMs: null,
      latencyMs: 0,
      textChars: 0,
      toolCalls: [],
      narrationForReview: '',
    };
    const start = Date.now();
    const text: string[] = [];
    try {
      for await (const chunk of this.inner.complete(effective)) {
        if (record.ttftMs === null && chunk.type !== 'usage')
          record.ttftMs = Date.now() - start;
        if (chunk.type === 'text') text.push(chunk.delta);
        else if (chunk.type === 'tool-call')
          record.toolCalls.push({ name: chunk.name, args: chunk.arguments });
        else {
          record.inputTokens += chunk.usage.input;
          record.outputTokens += chunk.usage.output;
        }
        yield chunk;
      }
    } catch (error) {
      record.errorCode =
        (error as { code?: string }).code ?? 'unclassified-error';
      throw error;
    } finally {
      record.latencyMs = Date.now() - start;
      record.narrationForReview = text.join('');
      record.textChars = record.narrationForReview.length;
      this.calls.push(record);
    }
  }
}

function md(value: unknown): string {
  return JSON.stringify(value, null, 0);
}

it.skipIf(process.env.LIVE_LLM !== '1')(
  'records Adventure #1 solo turns against the local qwen endpoint',
  async () => {
    if (MODEL.includes('swift'))
      throw new Error('swift models are not permitted');
    const databaseUrl = process.env.DATABASE_URL;
    const apiKey = process.env.LLM_API_KEY;
    if (!databaseUrl || !apiKey)
      throw new Error('DATABASE_URL and LLM_API_KEY are required');
    if (
      !(process.env.LLM_ALLOW_LOCAL_HOSTS ?? '')
        .split(',')
        .includes('172.31.25.75')
    )
      throw new Error('LLM_ALLOW_LOCAL_HOSTS must include 172.31.25.75');
    const maxTokensFloor = process.env.LIVE_MAX_TOKENS
      ? Number(process.env.LIVE_MAX_TOKENS)
      : undefined;

    const db = new Pool({ connectionString: databaseUrl });
    const dir = await mkdtemp(join(tmpdir(), 'lk-live-'));
    const started = new Date().toISOString();
    try {
      const catalog = loadCatalog();
      const built = quickBuild(catalog, 'class:cleric', 0x28, 1).character;
      const character = { ...built, id: randomUUID() };
      expect(validateCharacter(character, catalog)).toEqual([]);

      const accountId = randomUUID();
      await db.query(
        `INSERT INTO accounts(id,email,password_hash,display_name,status,is_adult,age_checked_at,terms_version,terms_accepted_at) VALUES($1,$2,'hash','Live Transcript','active',true,now(),'v1',now())`,
        [accountId, `${accountId}@example.test`],
      );
      const sessionId = randomUUID();
      await db.query(
        `INSERT INTO catalog_snapshots(catalog_version,entries) VALUES($1,$2::jsonb) ON CONFLICT (catalog_version) DO NOTHING`,
        [catalog.catalogVersion, JSON.stringify(catalog.entries)],
      );
      await db.query(
        `INSERT INTO sessions(id,owner_account_id,name,status,mode,adventure_id,difficulty,catalog_version,premise,character_id,character)
         VALUES($1,$2,$3,'active','solo',$4,$5,$6,$7,$8,$9::jsonb)`,
        [
          sessionId,
          accountId,
          'Live transcript',
          ADVENTURE,
          'moderate',
          catalog.catalogVersion,
          adventure01.premise,
          character.id,
          JSON.stringify(character),
        ],
      );

      const endpoint = new Recording(
        new OpenAICompatibleAdapter({
          baseUrl: BASE_URL,
          model: MODEL,
          apiKey: new Secret(apiKey),
          egress: createEndpointEgress(),
          timeoutMs: ENDPOINT_TIMEOUT_MS,
        }),
        maxTokensFloor,
      );
      const runner = new ProductionSoloTurnRunner(
        db,
        undefined,
        'record',
        join(dir, 'fixture.ndjson'),
        endpoint,
      );

      let state: Record<string, unknown> = {
        characters: { [accountId]: character },
        sceneId: START_SCENE,
        adventureId: ADVENTURE,
      };
      type Turn = {
        n: number;
        id: string;
        player: string;
        sceneBefore: string;
        sceneAfter: string;
        narration: string;
        fallback?: string;
        rejected: { toolName: string; error: string; attempt: number }[];
        rolls: unknown[];
        closed: { sceneId: string; nextSceneId?: string; summary: string }[];
        eventCounts: Record<string, number>;
        completed?: boolean;
        usage: { in: number; out: number };
        wallMs: number;
        calls: CallRecord[];
        error?: string;
      };
      const turns: Turn[] = [];

      for (const [index, prompt] of PROMPTS.entries()) {
        if (endpoint.calls.length >= MAX_MODEL_CALLS - 6) break;
        endpoint.currentTurn = index + 1;
        const sceneBefore = String(state.sceneId ?? '');
        const events: Record<string, unknown>[] = [];
        const callStart = endpoint.calls.length;
        const t0 = Date.now();
        let error: string | undefined;
        let result: Awaited<ReturnType<typeof runner.run>> | undefined;
        try {
          result = await runner.run(
            {
              sessionId,
              accountId,
              actionId: randomUUID(),
              text: prompt.text,
              state,
              playerName: 'Adventurer',
            },
            (event) => events.push(event as Record<string, unknown>),
          );
        } catch (caught) {
          error = (caught as Error).message;
        }
        const ofType = (type: string) =>
          events.filter((event) => event.type === type);
        const eventCounts: Record<string, number> = {};
        for (const event of events) {
          const type = String(event.type);
          eventCounts[type] = (eventCounts[type] ?? 0) + 1;
        }
        turns.push({
          n: index + 1,
          id: prompt.id,
          player: prompt.text,
          sceneBefore,
          sceneAfter: String(
            (result?.state &&
              (result.state as Record<string, unknown>).sceneId) ||
              sceneBefore,
          ),
          narration: result?.narration ?? '',
          ...(result?.fallback ? { fallback: result.fallback } : {}),
          rejected: ofType('ToolCallRejected').map((event) => ({
            toolName: String(event.toolName),
            error: String(event.error),
            attempt: Number(event.attempt),
          })),
          rolls: ofType('RollEvent'),
          closed: ofType('SceneClosed').map((event) => ({
            sceneId: String(event.sceneId),
            ...(event.nextSceneId
              ? { nextSceneId: String(event.nextSceneId) }
              : {}),
            summary: String(event.summary),
          })),
          eventCounts,
          ...(result
            ? {
                completed: (result.state as Record<string, unknown>)
                  .adventureCompleted as boolean | undefined,
              }
            : {}),
          usage: result?.usage ?? { in: 0, out: 0 },
          wallMs: Date.now() - t0,
          calls: endpoint.calls.slice(callStart),
          ...(error ? { error } : {}),
        });
        if (error || !result) break;
        state = result.state as Record<string, unknown>;
      }

      const lines: string[] = [];
      const totalCalls = endpoint.calls.length;
      lines.push(
        '# M2 live evidence: Adventure #1 solo turns on local qwen',
        '',
        `Run started ${started}. Endpoint: \`${BASE_URL}\` (local stand-in; not the hosted reference endpoint). Model: \`${MODEL}\`. Tool mode: native (per the probe record in \`docs/plan/m2-proof-report.md\`).`,
        '',
        `Adventure \`${ADVENTURE}\`, start scene \`${START_SCENE}\`. Character: \`class:cleric\` level 1 (quickBuild, seed 0x28), actor id scrubbed to a random UUID. Runner: \`ProductionSoloTurnRunner\` with a real \`OpenAICompatibleAdapter\` (stream timeout ${ENDPOINT_TIMEOUT_MS} ms; production default is 12000 ms). maxTokens: ${maxTokensFloor ? `floor ${maxTokensFloor} applied by harness (LIVE_MAX_TOKENS)` : 'production values (512 first request, 400 after tool results, set in `orchestrator.ts`)'}.`,
        '',
        `Model calls this run: ${totalCalls} (budget ${MAX_MODEL_CALLS}). Credential supplied via env only; not recorded. Scratch database and fixture directory were discarded.`,
        '',
        '## Summary',
        '',
        '| # | Player input (id) | DM calls | Summary calls | Tool calls requested | Rejected | Rolls | close_scene | Scene before -> after | Fallback | Out tokens | Wall ms | Error |',
        '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
      );
      for (const turn of turns) {
        const dm = turn.calls.filter((c) => c.kind === 'dm');
        const summary = turn.calls.filter((c) => c.kind === 'summary');
        const requested = dm.reduce((n, c) => n + c.toolCalls.length, 0);
        const requestedNames = dm
          .flatMap((c) => c.toolCalls.map((t) => t.name))
          .join(', ');
        const out = turn.calls.reduce((n, c) => n + c.outputTokens, 0);
        lines.push(
          `| ${turn.n} | ${turn.player.replace(/\|/g, '/')} (${turn.id}) | ${dm.length} | ${summary.length} | ${requested}${requestedNames ? ` (${requestedNames})` : ''} | ${turn.rejected.length} | ${turn.rolls.length} | ${turn.closed.length ? `yes -> ${turn.closed.map((c) => c.sceneId + (c.nextSceneId ? ` next=${c.nextSceneId}` : ' next=none')).join('; ')}` : 'no'} | ${turn.sceneBefore} -> ${turn.sceneAfter} | ${turn.fallback ?? '-'} | ${out} | ${turn.wallMs} | ${turn.error ?? '-'} |`,
        );
      }
      lines.push('', '## Turns', '');
      for (const turn of turns) {
        lines.push(
          `### Turn ${turn.n}: ${turn.id}`,
          '',
          `Player: ${turn.player}`,
          '',
          'Narration (as delivered by the orchestrator):',
          '',
          ...(turn.narration
            ? turn.narration.split('\n').map((line) => `> ${line}`)
            : ['> (none)']),
          '',
          `Fallback: ${turn.fallback ?? 'none'}. Scene: ${turn.sceneBefore} -> ${turn.sceneAfter}${turn.completed !== undefined ? `. adventureCompleted=${turn.completed}` : ''}. Turn usage in/out: ${turn.usage.in}/${turn.usage.out}.`,
          '',
        );
        for (const call of turn.calls) {
          lines.push(
            `- call ${call.kind}: maxTokens=${call.maxTokens}, in=${call.inputTokens}, out=${call.outputTokens}, ttft=${call.ttftMs ?? 'n/a'} ms, latency=${call.latencyMs} ms, visible text chars=${call.textChars}${call.errorCode ? `, error=${call.errorCode}` : ''}`,
          );
          for (const tool of call.toolCalls)
            lines.push(`  - tool requested: \`${tool.name}\` ${md(tool.args)}`);
        }
        for (const rejection of turn.rejected)
          lines.push(
            `- tool rejected: \`${rejection.toolName}\` error=${rejection.error} attempt=${rejection.attempt}`,
          );
        for (const roll of turn.rolls) lines.push(`- roll: ${md(roll)}`);
        for (const closed of turn.closed)
          lines.push(
            `- scene closed: ${closed.sceneId} next=${closed.nextSceneId ?? 'none'} summary=${JSON.stringify(closed.summary)}`,
          );
        if (turn.error) lines.push(`- ERROR: ${turn.error}`);
        const otherEvents = Object.entries(turn.eventCounts)
          .filter(
            ([type]) =>
              !['NarrationChunk', 'NarrationCompleted'].includes(type),
          )
          .map(([type, count]) => `${type}x${count}`)
          .join(', ');
        lines.push(`- events: ${otherEvents || 'none'}`, '');
      }
      const body = lines.join('\n') + '\n';
      expect(body).not.toContain(apiKey);
      expect(body).not.toMatch(/authorization|bearer/i);
      await mkdir(dirname(OUT_PATH), { recursive: true });
      await writeFile(OUT_PATH, body);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await db.end();
    }
  },
  0,
);
