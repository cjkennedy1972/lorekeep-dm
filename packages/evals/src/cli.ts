#!/usr/bin/env node
import { runLiveAndStore } from './live.js';
import { recordedModel, runEval } from './run.js';
import type { EvalRecord } from './types.js';

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? undefined : process.argv[i + 1];
};
const print = (r: EvalRecord) => {
  console.log(
    `eval v0 [${r.mode}] profile=${r.endpointProfileId} model=${r.model} seed=${r.seed}`,
  );
  for (const [name, s] of Object.entries(r.suites))
    console.log(
      `  ${name.padEnd(17)} score=${s.score.toFixed(3)} n=${s.n} ${s.pass ? 'PASS' : 'FAIL'}${s.failures.length ? ` (failed: ${s.failures.slice(0, 5).join(',')}${s.failures.length > 5 ? ',…' : ''})` : ''}`,
    );
  console.log(`  overall ${r.passed ? 'PASS' : 'FAIL'}\n  note: ${r.note}`);
};

const live = process.argv.includes('--live');
const seed = Number(arg('seed') ?? 1);
let record: EvalRecord;
if (live) {
  const [baseUrl, model, profile] = [
    arg('base-url'),
    arg('model'),
    arg('profile'),
  ];
  if (!baseUrl || !model || !profile)
    throw new Error(
      '--live requires --base-url, --model and --profile (endpoint profile id)',
    );
  const stored = await runLiveAndStore({
    baseUrl,
    model,
    profile,
    seed,
    out: arg('out'),
  });
  record = stored.record;
  console.log(`record written: ${stored.path}`);
} else {
  const fixture =
    arg('fixture') ??
    new URL('../data/recorded.json', import.meta.url).pathname;
  record = await runEval(recordedModel(fixture), {
    mode: 'recorded',
    endpointProfileId: 'recorded-fixture',
    modelName: 'recorded',
    seed,
  });
}
print(record);
// recorded mode gates CI; a failing live record is a result, not a harness error
if (!live && !record.passed) process.exitCode = 1;
