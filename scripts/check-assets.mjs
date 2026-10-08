#!/usr/bin/env node
// Release check for assets/manifest.json (spec US-M1 AC3, §8). Exit 1 when:
//  - an asset file on disk has no manifest entry (or an entry has no file, or its sha256 differs);
//  - an entry lacks origin/author/license or uses a license outside the allowlist;
//  - an entry's license requires attribution (CC-BY-*) and its attribution text is not in a legal source;
//  - the exact SRD 5.2.1 attribution statement is absent from every manifest `legalSources` file.
//
//   node scripts/check-assets.mjs [--root <dir>]     (manifest at <root>/assets/manifest.json)
import console from 'node:console';
import process from 'node:process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ASSET_EXT =
  /\.(png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|eot|glb|gltf|mp3|ogg|wav)$/i;
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'coverage',
  'test-results',
  'playwright-report',
  'docs',
]);
// ponytail: allowlist is a fixed set; add an SPDX id here when a new license is approved.
const LICENSES = new Set([
  'CC0-1.0',
  'CC-BY-4.0',
  'MIT',
  'Apache-2.0',
  'OFL-1.1',
  'LicenseRef-first-party',
]);
// Exact statement required by spec §8; hard-coded so the manifest cannot weaken it.
const SRD_ATTRIBUTION =
  'This work includes material from the System Reference Document 5.2.1 ("SRD 5.2.1") by Wizards of the Coast LLC, available at https://www.dndbeyond.com/srd. The SRD 5.2.1 is licensed under the Creative Commons Attribution 4.0 International License, available at https://creativecommons.org/licenses/by/4.0/legalcode.';
const NEEDS_ATTRIBUTION = (l) => l.startsWith('CC-BY');

export function checkAssets(root) {
  const errors = [];
  const manifest = JSON.parse(
    readFileSync(join(root, 'assets/manifest.json'), 'utf8'),
  );
  const entries = manifest.assets ?? [];
  const byPath = new Map();
  for (const [i, e] of entries.entries()) {
    const id = e.path ?? `assets[${i}]`;
    if (typeof e.path !== 'string' || !e.path)
      errors.push(`${id}: missing path`);
    else if (byPath.has(e.path)) errors.push(`${id}: duplicate entry`);
    else byPath.set(e.path, e);
    for (const f of ['kind', 'origin', 'author', 'license'])
      if (!e[f])
        errors.push(`${id}: missing ${f} (no recorded origin/license)`);
    if (e.license && !LICENSES.has(e.license))
      errors.push(`${id}: license "${e.license}" is not in the allowlist`);
    if (e.license && NEEDS_ATTRIBUTION(e.license) && !e.attribution)
      errors.push(`${id}: ${e.license} requires an attribution text`);
  }

  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        if (!SKIP_DIRS.has(name)) walk(full);
      } else if (ASSET_EXT.test(name) || relative(root, dir) === 'assets')
        files.push(relative(root, full).split('\\').join('/'));
    }
  };
  walk(root);
  for (const f of files) {
    if (f === 'assets/manifest.json') continue;
    const e = byPath.get(f);
    if (!e) errors.push(`${f}: asset has no manifest entry`);
    else if (e.sha256) {
      const h = createHash('sha256')
        .update(readFileSync(join(root, f)))
        .digest('hex');
      if (h !== e.sha256) errors.push(`${f}: sha256 differs from manifest`);
    } else errors.push(`${f}: manifest entry has no sha256`);
  }
  for (const p of byPath.keys())
    if (!files.includes(p)) errors.push(`${p}: manifest entry has no file`);

  const legal = (manifest.legalSources ?? []).map((p) => {
    try {
      return readFileSync(join(root, p), 'utf8');
    } catch {
      errors.push(`${p}: legal source not readable`);
      return '';
    }
  });
  const inLegal = (text) => legal.some((t) => t.includes(text));
  if (!inLegal(SRD_ATTRIBUTION))
    errors.push('SRD 5.2.1 attribution statement missing from legalSources');
  for (const e of entries)
    if (e.attribution && !inLegal(e.attribution))
      errors.push(`${e.path}: attribution text missing from legalSources`);
  return { errors, assets: files.length - 1 };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--root');
  const root =
    i < 0
      ? resolve(dirname(fileURLToPath(import.meta.url)), '..')
      : resolve(process.argv[i + 1]);
  const { errors, assets } = checkAssets(root);
  if (errors.length) {
    console.error(`check-assets: ${errors.length} problem(s)`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log(
    `check-assets: ok (${assets} asset file(s), attribution present)`,
  );
}
