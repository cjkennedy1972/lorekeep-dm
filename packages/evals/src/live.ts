import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { runEval } from './run.js';
import type { EvalModel, EvalRecord } from './types.js';

/** Hosts allowed for plain-http/loopback endpoints; same contract as LLM_ALLOW_LOCAL_HOSTS (exact hosts, no wildcard). */
export function checkLiveUrl(
  baseUrl: string,
  allowLocal = process.env.LLM_ALLOW_LOCAL_HOSTS ?? '',
): URL {
  const url = new URL(baseUrl);
  const allowed = allowLocal
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);
  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && allowed.includes(url.hostname))
  )
    throw new Error(
      `live endpoint ${url.hostname} must be https or listed in LLM_ALLOW_LOCAL_HOSTS`,
    );
  return url;
}

/** OpenAI-compatible chat completions, temperature 0 and the per-case seed. Key from EVAL_API_KEY only. */
export function liveModel(
  baseUrl: string,
  model: string,
  apiKey = process.env.EVAL_API_KEY,
): EvalModel {
  const url = checkLiveUrl(baseUrl);
  return async ({ prompt, seed }) => {
    const res = await fetch(
      `${url.toString().replace(/\/$/, '')}/chat/completions`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          model,
          temperature: 0,
          seed,
          max_tokens: 400,
          messages: [{ role: 'user', content: prompt }],
        }),
        signal: AbortSignal.timeout(120_000),
      },
    );
    if (!res.ok) throw new Error(`live endpoint returned ${res.status}`);
    const body = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    return body.choices?.[0]?.message?.content ?? '';
  };
}

/** Run the suites against a live endpoint and store the record, keyed by endpoint profile id. */
export async function runLiveAndStore(o: {
  baseUrl: string;
  model: string;
  profile: string;
  seed?: number;
  out?: string;
  apiKey?: string;
}): Promise<{ record: EvalRecord; path: string }> {
  const record = await runEval(liveModel(o.baseUrl, o.model, o.apiKey), {
    mode: 'live',
    endpointProfileId: o.profile,
    modelName: o.model,
    seed: o.seed,
  });
  const path = o.out ?? `eval-records/${o.profile}.json`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
  return { record, path };
}
