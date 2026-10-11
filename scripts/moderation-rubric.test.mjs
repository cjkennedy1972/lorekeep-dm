// Checks docs/security/moderation-rubric.md for M3-18 loading and the M3-08 verdict contract: node --test scripts/moderation-rubric.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CATEGORIES,
  REQUIRED_TAGS,
  parseRubric,
} from './moderation-rubric.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sections = parseRubric(
  readFileSync(join(root, 'docs/security/moderation-rubric.md'), 'utf8'),
);
const TIERS = ['rubric:family', 'rubric:standard', 'rubric:mature'];

const hardFloor = (body) =>
  body.split('\n').find((l) => l.startsWith('HARD FLOOR'));
const borderline = (body) =>
  body
    .slice(body.indexOf('Borderline examples:'))
    .split('\n')
    .filter((l) => l.startsWith('- '));

test('required sections exist exactly once', () => {
  for (const tag of REQUIRED_TAGS)
    assert.ok(sections.has(tag), `missing ${tag}`);
});

test('verdict schema enum matches the red-team README enum and parses as JSON', () => {
  const schema = sections.get('verdict-schema');
  const template = schema.split('\n').find((l) => l.startsWith('{"verdict"'));
  const categories = template.match(/"category":"([^"]+)"/)[1].split('|');
  assert.deepEqual(categories, CATEGORIES);
  const parsed = JSON.parse(
    template.replace('allow|block', 'allow').replace(/"none\|[^"]+"/, '"none"'),
  );
  assert.deepEqual(Object.keys(parsed).sort(), ['category', 'verdict']);
});

test('each tier rubric has allowed, blocked, decision order and at least six borderline examples', () => {
  for (const tag of TIERS) {
    const body = sections.get(tag);
    for (const marker of [
      'TIER:',
      'Decide in this order',
      'Allowed:',
      'Blocked:',
      'Borderline examples:',
    ]) {
      assert.ok(body.includes(marker), `${tag} missing "${marker}"`);
    }
    assert.ok(
      borderline(body).length >= 6,
      `${tag} needs >= 6 borderline examples`,
    );
  }
});

test('hard floor is identical at every tier and names minor_sexual', () => {
  const floor = hardFloor(sections.get(TIERS[0]));
  assert.ok(floor && floor.includes('minor_sexual'));
  for (const tag of TIERS)
    assert.equal(
      hardFloor(sections.get(tag)),
      floor,
      `${tag} hard floor differs`,
    );
});

test('mature rubric covers graphic violence, dark themes, strong language, innuendo and blocks explicit sex', () => {
  const mature = sections.get('rubric:mature');
  for (const term of [
    'graphic violence',
    'dark themes',
    'strong language',
    'innuendo',
  ]) {
    assert.ok(mature.includes(term), `mature missing ${term}`);
  }
  assert.match(mature, /Explicit sexual content[^\n]*block, category sexual/);
});

test('mature clause forbids explicit sexual content and defers to the hard floor', () => {
  const clause = sections.get('clause:mature');
  assert.match(clause, /never describe sex acts or anatomy/);
  assert.match(clause, /hard floor/);
});

test('rubric files carry no interpolation placeholders', () => {
  for (const tag of REQUIRED_TAGS)
    assert.doesNotMatch(sections.get(tag), /\{\{|\$\{|<%/, tag);
});
