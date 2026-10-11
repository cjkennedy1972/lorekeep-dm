// Sends boundary prompts to the configured moderation judge and prints verdicts and latencies.
// Env: MODERATION_PROBE_URL (OpenAI-compatible base URL, e.g. https://host/v1),
//      MODERATION_PROBE_MODEL, MODERATION_PROBE_KEY_VAR (name of the env var holding the key; optional),
//      MODERATION_PROBE_COUNT (optional, default 5), LLM_ALLOW_LOCAL_HOSTS (optional, as in the server).
// The API key value is read at runtime and never printed or written.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createEgressGuard } from '../dist/llm/egress.js';
import { JudgeModerator } from '../dist/safety/moderator.js';

const env = process.env;
const baseUrl = env.MODERATION_PROBE_URL;
const model = env.MODERATION_PROBE_MODEL;
if (!baseUrl || !model) {
  console.error(
    'Set MODERATION_PROBE_URL and MODERATION_PROBE_MODEL (see the header of this script).',
  );
  process.exit(1);
}
const keyVar = env.MODERATION_PROBE_KEY_VAR ?? 'MODERATION_PROBE_API_KEY';
const apiKey = env[keyVar];
const count = Number(env.MODERATION_PROBE_COUNT ?? 5);

const egress = createEgressGuard({
  allowLocalHosts: (env.LLM_ALLOW_LOCAL_HOSTS ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean),
});

const chat = async ({ messages, temperature, max_tokens, signal }) => {
  const response = await egress.fetch(
    `${baseUrl.replace(/\/+$/, '')}/chat/completions`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({ model, messages, temperature, max_tokens }),
      signal,
    },
  );
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = await response.json();
  return body?.choices?.[0]?.message?.content ?? '';
};

const dataset = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL(
        '../../../packages/evals/redteam/boundary-100.json',
        import.meta.url,
      ),
    ),
    'utf8',
  ),
);
const cases = dataset.cases
  .filter(
    (_, i) => i % Math.max(1, Math.floor(dataset.cases.length / count)) === 0,
  )
  .slice(0, count);

// Judge only: the deterministic layer (hard floor, denylist) is not part of this probe.
const moderator = new JudgeModerator({
  chat,
  deterministic: {
    hardFloorCheck: () => ({ blocked: false }),
    denylistCheck: () => ({ blocked: false }),
    maxSpanChars: 0,
  },
});

console.log(
  `endpoint=${baseUrl} model=${model} key=${apiKey ? `from ${keyVar}` : 'none'} cases=${cases.length}`,
);
for (const c of cases) {
  const v = await moderator.moderate({
    text: c.text,
    tier: c.tier,
    tableLines: c.tableLines ?? [],
    direction: 'input',
  });
  const match =
    v.verdict === c.expected && v.category === c.category
      ? 'match'
      : 'MISMATCH';
  console.log(
    [
      c.id,
      c.tier,
      `expected=${c.expected}/${c.category}`,
      `got=${v.verdict}/${v.category}`,
      `source=${v.source}`,
      `unavailable=${v.unavailable}`,
      `latency=${Math.round(v.latencyMs)}ms`,
      match,
    ].join('  '),
  );
}
