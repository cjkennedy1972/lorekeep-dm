// Negative tests for scripts/check-assets.mjs: node --test scripts/check-assets.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { checkAssets } from './check-assets.mjs';

const real = join(dirname(fileURLToPath(import.meta.url)), '..');
const stmt = readFileSync(join(real, 'README.md'), 'utf8').match(
  /This work includes material from the System Reference Document 5\.2\.1.*legalcode\./,
)[0];

function fixture({ legal = stmt, assets = [], files = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'assets-'));
  mkdirSync(join(root, 'assets'));
  writeFileSync(join(root, 'README.md'), legal);
  writeFileSync(
    join(root, 'assets/manifest.json'),
    JSON.stringify({ legalSources: ['README.md'], assets }),
  );
  for (const [f, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, f)), { recursive: true });
    writeFileSync(join(root, f), body);
  }
  return root;
}
const entry = (body, extra = {}) => ({
  path: 'assets/tokens/orc.png',
  kind: 'token',
  origin: 'drawn in-house',
  author: 'Lorekeep',
  license: 'LicenseRef-first-party',
  sha256: createHash('sha256').update(body).digest('hex'),
  ...extra,
});
const f = { 'assets/tokens/orc.png': 'png-bytes' };

test('real repo passes', () => {
  assert.deepEqual(checkAssets(real).errors, []);
});
test('valid fixture passes', () => {
  const r = fixture({ assets: [entry('png-bytes')], files: f });
  assert.deepEqual(checkAssets(r).errors, []);
});
test('asset file without manifest entry fails', () => {
  const e = checkAssets(fixture({ files: f })).errors;
  assert.match(e.join('\n'), /orc\.png: asset has no manifest entry/);
});
test('asset outside assets/ (apps/web/public) without entry fails', () => {
  const e = checkAssets(
    fixture({ files: { 'apps/web/public/x.woff2': 'f' } }),
  ).errors;
  assert.match(e.join('\n'), /x\.woff2: asset has no manifest entry/);
});
test('entry without license or origin fails', () => {
  const e = checkAssets(
    fixture({
      assets: [entry('png-bytes', { license: '', origin: '' })],
      files: f,
    }),
  ).errors.join('\n');
  assert.match(e, /missing license/);
  assert.match(e, /missing origin/);
});
test('license outside allowlist fails', () => {
  const e = checkAssets(
    fixture({ assets: [entry('png-bytes', { license: 'WTFPL' })], files: f }),
  ).errors.join('\n');
  assert.match(e, /not in the allowlist/);
});
test('CC-BY asset with unmet attribution fails', () => {
  const a = entry('png-bytes', {
    license: 'CC-BY-4.0',
    attribution: 'Orc art by Jane Doe, CC BY 4.0',
  });
  assert.match(
    checkAssets(fixture({ assets: [a], files: f })).errors.join('\n'),
    /attribution text missing/,
  );
  const ok = fixture({
    legal: `${stmt}\nOrc art by Jane Doe, CC BY 4.0`,
    assets: [a],
    files: f,
  });
  assert.deepEqual(checkAssets(ok).errors, []);
});
test('changed file bytes fail sha256', () => {
  const e = checkAssets(
    fixture({ assets: [entry('other')], files: f }),
  ).errors.join('\n');
  assert.match(e, /sha256 differs/);
});
test('missing or altered SRD statement fails', () => {
  for (const legal of ['', stmt.replace('5.2.1', '5.1')])
    assert.match(
      checkAssets(fixture({ legal })).errors.join('\n'),
      /SRD 5\.2\.1 attribution statement missing/,
    );
});
