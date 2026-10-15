// Production-path, player-visible first-token probe for M3-30.
// Requires DATABASE_URL, OPERATOR_ENDPOINT_MASTER_KEY, and operator-configured
// `moderate` + `fast` slots. Makes one synthetic moderation request and one
// read-only synthetic narration request; no session, tool execution, DB writes, or fixture
// recording. Endpoint values and credentials are deliberately never printed.
// Set FIRST_TOKEN_PROBE_CONFIRM=1 to acknowledge outbound synthetic prompts.
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

try {
  const egress = createEndpointEgress();
  const [moderate, fast] = await Promise.all([
    createConfiguredAdapter(pool, 'moderate', egress),
    createConfiguredAdapter(pool, 'fast', egress),
  ]);

  const judge = new JudgeModerator({
    chat: async ({ messages, temperature, max_tokens, signal }) => {
      let text = '';
      for await (const chunk of moderate.complete({
        messages,
        temperature,
        maxTokens: max_tokens,
        signal,
      }))
        if (chunk.type === 'text') text += chunk.delta;
      return text;
    },
    deterministic: hardFloorLayer,
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

  const inputMs = [];
  const gateMs = [];
  const visibleMs = [];

  for (let i = 0; i < count; i++) {
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

    const request = {
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      maxTokens: 512,
      toolMode: 'native',
    };
    const outputStart = performance.now();
    let modelText = '';
    for await (const chunk of fast.complete(request))
      if (chunk.type === 'text') modelText += chunk.delta;
    const modelDone = performance.now();
    if (!modelText.trim()) throw new Error(`empty narration on run ${i + 1}`);

    // Match runTurn's post-generation output gate behavior: 24-char chunks,
    // sensitive-text withholding, then one player-visible NarrationChunk after
    // all moderation is complete. This measures full first visible narration
    // from before the narration request through approval, not adapter TTFT.
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
    for await (const event of gate) {
      if (event.kind === 'chunk') safeText += event.text;
      if (event.kind === 'end') outcome = event.outcome;
    }
    const visible = outcome === 'redirected' ? 'safe redirect' : safeText;
    if (!visible)
      throw new Error(`output gate produced no text on run ${i + 1}`);
    const visibleAt = performance.now();
    gateMs.push(visibleAt - modelDone);
    visibleMs.push(visibleAt - outputStart);
    if (i === 0) console.log(`prompt_sha256=${digest(system + '\n\n' + user)}`);
  }

  console.log(`runs=${count} prompt_cache=not_requested_no_cache_hints`);
  console.log(`input_judge=${JSON.stringify(summarize(inputMs))}`);
  console.log(
    `output_gate_after_model_complete=${JSON.stringify(summarize(gateMs))}`,
  );
  console.log(
    `first_visible_narration_from_model_request=${JSON.stringify(summarize(visibleMs))}`,
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
  console.error(`probe failed (${code}); endpoint details omitted`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
