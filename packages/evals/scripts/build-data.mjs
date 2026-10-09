// Deterministic generator for data/*.json. Run: node scripts/build-data.mjs
// Recorded responses are SYNTHETIC fixtures authored for harness validation, not model output.
import { readFileSync, writeFileSync } from 'node:fs';
import { URL } from 'node:url';
import seed from './rules-seed.mjs';

const out = (name, value) =>
  writeFileSync(
    new URL(`../data/${name}`, import.meta.url),
    `${JSON.stringify(value, null, 2)}\n`,
  );
const srd = JSON.parse(
  readFileSync(new URL('../../engine/srd-text/chunks.json', import.meta.url)),
);
const chunks = srd.chunks.map((c) => ({
  id: c.id,
  text: c.text.replace(/- /g, ''),
}));
// mulberry32: fixed-seed shuffle so contexts are reproducible
const rng = (a) => () => {
  a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const rules = seed.map(([question, pattern, keywords], i) => {
  const cite = chunks.find(
    (c) =>
      new RegExp(pattern, 'is').test(c.text) &&
      keywords.every((k) => new RegExp(k, 'i').test(c.text)),
  );
  if (!cite) throw new Error(`no SRD chunk for rules case ${i}`);
  const r = rng(1000 + i);
  const distract = [];
  while (distract.length < 2) {
    const d = chunks[Math.floor(r() * chunks.length)];
    if (d.id !== cite.id && !distract.includes(d)) distract.push(d);
  }
  const context = [cite, ...distract]
    .sort(() => r() - 0.5)
    .map((c) => ({ id: c.id, text: c.text.slice(0, 900) }));
  return {
    id: `rules-${String(i + 1).padStart(2, '0')}`,
    question,
    citation: cite.id,
    keywords,
    context,
  };
});

const names = ['Mira', 'Tobin', 'Sable', 'Quill', 'Brann'];
const scenes = [
  'a flooded cellar',
  'a moonlit ridge',
  'a market square at dusk',
  'a collapsed mine shaft',
  'a quiet chapel',
  'a reed-choked marsh',
  'a torchlit corridor',
  'an abandoned watchtower',
  'a frozen lake shore',
  'a smoky tavern',
];
const actions = [
  'I look around.',
  'I examine the nearest door.',
  'I ask the stranger what he knows.',
  'I listen at the wall.',
  'I search the floor for tracks.',
];
const explore = Array.from({ length: 50 }, (_, i) => ({
  id: `explore-${String(i + 1).padStart(2, '0')}`,
  pc: names[i % names.length],
  scene: scenes[i % scenes.length],
  playerAction: actions[Math.floor(i / 10)],
}));
const exploreClean = (c) =>
  `${c.pc}, ${c.scene.replace(/^an? /, 'the ')} stretches before you. A cold draught stirs the dust and something small scrapes out of sight. What do you do?`;
const exploreBad = (c) =>
  `${c.pc} feels uneasy and decides to draw a sword. You think this is a trap and step forward.`;

const dead = ['Bandit', 'Cultist'];
const live = ['Goblin', 'Wolf', 'Skeleton'];
const combat = Array.from({ length: 30 }, (_, i) => {
  const px = 2 + (i % 4);
  const entities = [
    { name: 'Mira', kind: 'pc', x: px, y: 3, alive: true },
    { name: live[i % 3], kind: 'foe', x: px + 1, y: 3, alive: true },
    {
      name: live[(i + 1) % 3],
      kind: 'foe',
      x: px + 4 + (i % 3),
      y: 8,
      alive: true,
    },
    { name: dead[i % 2], kind: 'foe', x: px + 2, y: 5, alive: false },
  ];
  return {
    id: `combat-${String(i + 1).padStart(2, '0')}`,
    grid: { width: 16, height: 12 },
    entities,
    action: `Mira attacks the ${entities[1].name}.`,
  };
});
const combatClean = (c) =>
  `Mira's blade finds the ${c.entities[1].name} beside her. Far across the room the ${c.entities[2].name} watches, and the fallen ${c.entities[3].name} lies still.`;
const combatBad = (c) =>
  `The ${c.entities[3].name} attacks Mira from behind while an ogre roars. The ${c.entities[2].name} stands adjacent to her.`;

const tools = [
  {
    name: 'move_token',
    description: 'Move a token to a named map area.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['tokenId', 'areaId'],
      properties: { tokenId: { type: 'string' }, areaId: { type: 'string' } },
    },
  },
  {
    name: 'roll_check',
    description: 'Request an ability check.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['ability', 'dc'],
      properties: {
        ability: {
          type: 'string',
          enum: ['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA'],
        },
        dc: { type: 'integer' },
      },
    },
  },
  {
    name: 'apply_damage',
    description: 'Apply damage to a target.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['targetId', 'amount', 'type'],
      properties: {
        targetId: { type: 'string' },
        amount: { type: 'integer' },
        type: { type: 'string' },
      },
    },
  },
];
const toolCalls = [
  ['move_token', (i) => ({ tokenId: `tok-${i}`, areaId: 'area-door' })],
  [
    'roll_check',
    (i) => ({ ability: ['STR', 'DEX', 'WIS', 'CHA'][i % 4], dc: 10 + (i % 6) }),
  ],
  [
    'apply_damage',
    (i) => ({ targetId: `mon-${i}`, amount: 3 + (i % 5), type: 'slashing' }),
  ],
];
const toolCases = Array.from({ length: 20 }, (_, i) => {
  const [name, args] = toolCalls[i % 3];
  return {
    id: `tool-${String(i + 1).padStart(2, '0')}`,
    instruction: `Call ${name} for scenario ${i + 1}.`,
    tools,
    expectTool: name,
    args: args(i),
  };
});
const toolGood = (c) =>
  JSON.stringify({ name: c.expectTool, arguments: c.args });
// every 4th failing call supplies coordinates the LLM must never supply
const toolBad = (c, i) =>
  i % 4 === 0
    ? JSON.stringify({
        name: 'move_token',
        arguments: { tokenId: 'tok', x: 4, y: 7 },
      })
    : toolGood(c);

const rulesGood = (c) => `${c.keywords.join(', ')} [${c.citation}]`;
const rulesBad = (c, i) => (i % 3 === 0 ? 'DM discretion.' : rulesGood(c));
const fixture = (pick) => ({
  rules: Object.fromEntries(rules.map((c, i) => [c.id, pick.rules(c, i)])),
  puppeting: Object.fromEntries(
    explore.map((c, i) => [c.id, pick.explore(c, i)]),
  ),
  mapContradiction: Object.fromEntries(
    combat.map((c, i) => [c.id, pick.combat(c, i)]),
  ),
  toolValidity: Object.fromEntries(
    toolCases.map((c, i) => [c.id, pick.tool(c, i)]),
  ),
});

out('rules.json', {
  attribution: srd.metadata.attribution,
  license: srd.metadata.license,
  cases: rules,
});
out('explore.json', explore);
out('combat.json', combat);
out('tools.json', toolCases);
out(
  'recorded.json',
  fixture({
    rules: rulesGood,
    explore: exploreClean,
    combat: combatClean,
    tool: toolGood,
  }),
);
out(
  'recorded-failing.json',
  fixture({
    rules: rulesBad,
    explore: exploreBad,
    combat: combatBad,
    tool: toolBad,
  }),
);
