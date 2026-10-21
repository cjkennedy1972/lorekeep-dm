// Production-path, player-visible first-token probe for M3-30.
// Requires DATABASE_URL, OPERATOR_ENDPOINT_MASTER_KEY, and operator-configured
// `moderate` + `fast` slots. Makes one synthetic moderation request and one
// read-only synthetic narration request; no session, tool execution, DB writes, or fixture
// recording. Endpoint values and credentials are deliberately never printed.
// Set FIRST_TOKEN_PROBE_CONFIRM=1 to acknowledge outbound synthetic prompts.
// Set FIRST_TOKEN_PROBE_CACHE_DISABLED=1 only after verifying the endpoint cache is off.
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Pool } from 'pg';
import { JudgeModerator } from '../dist/safety/moderator.js';
import { hardFloorLayer } from '../dist/safety/deterministicLayer.js';
import { buildPrompt } from '../dist/dm/prompt.js';
import { runOutputGate } from '../dist/safety/outputGate.js';
import {
  createConfiguredAdapter,
  createEndpointEgress,
} from '../dist/llm/config.js';

const env = process.env;
const count = Number(env.FIRST_TOKEN_PROBE_COUNT ?? 30);
if (!Number.isInteger(count) || count < 30 || count > 100) {
  console.error('FIRST_TOKEN_PROBE_COUNT must be an integer from 30 to 100.');
  process.exit(2);
}
if (env.FIRST_TOKEN_PROBE_CONFIRM !== '1') {
  console.error(
    'Set FIRST_TOKEN_PROBE_CONFIRM=1 after confirming synthetic prompts may be sent to the configured endpoints.',
  );
  process.exit(2);
}
if (env.FIRST_TOKEN_PROBE_CACHE_DISABLED !== '1') {
  console.error(
    'Disable and verify provider-side prompt caching; set FIRST_TOKEN_PROBE_CACHE_DISABLED=1 only afterward.',
  );
  process.exit(2);
}
if (!env.DATABASE_URL || !env.OPERATOR_ENDPOINT_MASTER_KEY) {
  console.error('DATABASE_URL and OPERATOR_ENDPOINT_MASTER_KEY are required.');
  process.exit(2);
}

const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
};
const summarize = (values) => ({
  n: values.length,
  p50_ms: Math.round(percentile(values, 0.5)),
  p95_ms: Math.round(percentile(values, 0.95)),
});
const digest = (text) =>
  `sha256:${createHash('sha256').update(text).digest('hex')}`;
const pool = new Pool({ connectionString: env.DATABASE_URL, max: 1 });
let phase = 'adapter-setup';

try {
  const egress = createEndpointEgress();
  const [moderate, fast] = await Promise.all([
    createConfiguredAdapter(pool, 'moderate', egress),
    createConfiguredAdapter(pool, 'fast', egress),
  ]);

  const chat = async ({ messages, temperature, max_tokens, signal }) => {
    let text = '';
    for await (const chunk of moderate.complete({
      messages,
      temperature,
      maxTokens: max_tokens,
      signal,
    }))
      if (chunk.type === 'text') text += chunk.delta;
    return text;
  };
  const judge = new JudgeModerator({
    chat,
    deterministic: hardFloorLayer,
  });
  const warmupJudge = new JudgeModerator({
    chat,
    deterministic: hardFloorLayer,
    timeoutMs: 20_000,
  });

  const prompt = buildPrompt({
    catalogVersion: 'm3-30-synthetic-v1',
    toolMode: 'native',
    sceneId: 'm3-30-synthetic',
    settingsHash: 'm3-30-synthetic-v1',
    session: {
      contentTier: 'standard',
      safetySettings: { lines: [], veils: [] },
      partyRoster: [{ id: 'synthetic-character', name: 'Ari' }],
      premise: 'A synthetic latency measurement scene.',
      sceneSummary: 'A traveler stands before a weathered stone arch.',
    },
    turn: {
      state: { characters: [] },
      playerText: 'Ari: I inspect the weathered stone arch for markings.',
      turns: [],
      registryFacts: [],
      retrievedMemory: [],
    },
    activeMode: 'exploration',
  });
  const system = `${prompt.blocks[0]}\n\n${prompt.blocks[1]}`;
  const user = `${prompt.blocks[2]}${prompt.blocks[3] ? `\n\n${prompt.blocks[3]}` : ''}`;
  const moderationText = 'I inspect the weathered stone arch for markings.';
  const tableLines = [];
  const tier = 'standard';
  const request = {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    maxTokens: 512,
    toolMode: 'native',
  };

  const inputMs = [];
  const gateMs = [];
  const visibleMs = [];
  // Per-gate-chunk judge latency from runOutputGate's end.metrics.chunks.
  // Excludes deterministic hard-floor/failclosed terminal decisions (no judge call).
  const gateChunkJudgeMs = [];
  const gateChunksPerRun = [];

  // Warm up model execution before measuring. The operator must separately
  // disable and verify provider-side prompt caching before setting the guard.
  phase = 'warmup-moderation';
  const warmVerdict = await warmupJudge.moderate({
    text: moderationText,
    tier,
    tableLines,
    direction: 'input',
  });
  if (
    !warmVerdict ||
    warmVerdict.verdict !== 'allow' ||
    warmVerdict.unavailable
  ) {
    throw new Error('moderation warmup failed');
  }
  phase = 'warmup-narration';
  let warmupNarration = '';
  for await (const chunk of fast.complete({ ...request, maxTokens: 8 }))
    if (chunk.type === 'text') warmupNarration += chunk.delta;
  if (!warmupNarration.trim()) throw new Error('narration warmup failed');

  for (let i = 0; i < count; i++) {
    phase = 'input-moderation';
    const inputStart = performance.now();
    const inputVerdict = await judge.moderate({
      text: moderationText,
      tier,
      tableLines,
      direction: 'input',
    });
    inputMs.push(performance.now() - inputStart);
    if (inputVerdict.verdict !== 'allow' || inputVerdict.unavailable)
      throw new Error(`input classifier did not allow run ${i + 1}`);

    phase = 'narration-model';
    const outputStart = performance.now();
    let modelText = '';
    for await (const chunk of fast.complete(request))
      if (chunk.type === 'text') modelText += chunk.delta;
    const modelDone = performance.now();
    if (!modelText.trim()) throw new Error(`empty narration on run ${i + 1}`);

    // Production runTurn buffers the complete model response before running
    // runOutputGate, then emits one player-visible narration after the gate.
    phase = 'output-gate';
    const gate = runOutputGate({
      stream: async function* () {
        for (let offset = 0; offset < modelText.length; offset += 24)
          yield modelText.slice(offset, offset + 24);
      },
      regenerate: async function* () {},
      moderator: judge,
      tier,
      tableLines,
      maxRegenerations: 0,
    });
    let outcome;
    let safeText = '';
    let gateMetrics;
    for await (const event of gate) {
      if (event.kind === 'chunk') safeText += event.text;
      if (event.kind === 'end') {
        outcome = event.outcome;
        gateMetrics = event.metrics;
      }
    }
    const judged = (gateMetrics?.chunks ?? []).filter(
      (c) => c.source !== 'hardfloor' && c.source !== 'failclosed',
    );
    gateChunksPerRun.push(judged.length);
    for (const c of judged) gateChunkJudgeMs.push(c.judgeLatencyMs);
    const visible = outcome === 'redirected' ? 'safe redirect' : safeText;
    if (!visible)
      throw new Error(`output gate produced no text on run ${i + 1}`);
    const visibleAt = performance.now();
    gateMs.push(visibleAt - modelDone);
    visibleMs.push(visibleAt - outputStart);
    if (i === 0) console.log(`prompt_sha256=${digest(system + '\n\n' + user)}`);
  }

  phase = 'complete';
  console.log(`runs=${count} prompt_cache=operator_attested_disabled`);
  console.log(`input_judge=${JSON.stringify(summarize(inputMs))}`);
  console.log(
    `output_gate_after_model_complete=${JSON.stringify(summarize(gateMs))}`,
  );
  console.log(
    `first_visible_narration_from_model_request=${JSON.stringify(summarize(visibleMs))}`,
  );
  const chunkSummary = gateChunkJudgeMs.length
    ? {
        ...summarize(gateChunkJudgeMs),
        max_ms: Math.round(Math.max(...gateChunkJudgeMs)),
      }
    : null;
  console.log(
    `output_gate_per_chunk_judge_latency_ms=${JSON.stringify(chunkSummary)}`,
  );
  console.log(
    `output_gate_judged_chunks_per_run=${JSON.stringify(summarize(gateChunksPerRun))}`,
  );
  console.log(
    'per_chunk_label="judge latency per gate chunk on the buffered path (production buffers before gating, ADR-023 addendum); per streamed production chunk NOT measured"',
  );
  console.log('classifier_on=true tier=standard tool_loop=not_exercised');
  console.log(
    'endpoint_identifiers=withheld; label run with operator-confirmed configuration',
  );
} catch (error) {
  // Only fixed messages/code to avoid leaking endpoint URLs, request bodies or keys.
  const code =
    error && typeof error === 'object' && 'code' in error
      ? String(error.code)
      : 'probe-failed';
  console.error(`probe failed at ${phase} (${code}); endpoint details omitted`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
