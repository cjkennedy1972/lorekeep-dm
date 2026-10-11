import { readFileSync, mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkLiveUrl,
  runLiveAndStore,
  mapContradictions,
  puppets,
  recordedModel,
  runEval,
  toolCallValid,
} from '../src/index.js';
import type {
  CombatCase,
  ExploreCase,
  RulesCase,
  ToolCase,
} from '../src/index.js';

const data = (n: string) =>
  JSON.parse(readFileSync(new URL(`../data/${n}`, import.meta.url), 'utf8'));
const fixture = (n: string) => new URL(`../data/${n}`, import.meta.url);
const run = (f: string, seed?: number) =>
  runEval(recordedModel(fixture(f)), {
    mode: 'recorded',
    endpointProfileId: 'recorded-fixture',
    modelName: 'recorded',
    seed,
    now: () => new Date(0),
  });

describe('datasets', () => {
  it('have the ticket sizes', () => {
    expect(data('rules.json').cases).toHaveLength(50);
    expect(data('explore.json')).toHaveLength(50);
    expect(data('combat.json')).toHaveLength(30);
  });
  it('every rules citation exists in the SRD chunks and supports the answer', () => {
    const srd = new Map<string, string>(
      JSON.parse(
        readFileSync(
          new URL('../../engine/srd-text/chunks.json', import.meta.url),
          'utf8',
        ),
      ).chunks.map((c: { id: string; text: string }) => [
        c.id,
        c.text.replace(/- /g, '').toLowerCase(),
      ]),
    );
    for (const c of data('rules.json').cases as RulesCase[]) {
      const text = srd.get(c.citation);
      expect(text, c.id).toBeTruthy();
      for (const k of c.keywords)
        expect(text, `${c.id} ${k}`).toMatch(new RegExp(k.toLowerCase()));
      expect(c.context.map((x) => x.id)).toContain(c.citation);
    }
  });
});

describe('scorers', () => {
  const ex: ExploreCase = {
    id: 'e',
    pc: 'Mira',
    scene: 's',
    playerAction: 'I look around.',
  };
  it('flags puppeting but not what the player asked for', () => {
    expect(puppets(ex, 'You feel afraid and step forward.')).toBe(true);
    expect(puppets(ex, 'Mira decides to run.')).toBe(true);
    expect(puppets(ex, 'A cold draught stirs. What do you do?')).toBe(false);
    expect(
      puppets(
        { ...ex, playerAction: 'I step forward.' },
        'You step into the dark.',
      ),
    ).toBe(false);
  });
  const cb: CombatCase = {
    id: 'c',
    grid: { width: 9, height: 9 },
    action: 'x',
    entities: [
      { name: 'Mira', kind: 'pc', x: 1, y: 1, alive: true },
      { name: 'Goblin', kind: 'foe', x: 2, y: 1, alive: true },
      { name: 'Wolf', kind: 'foe', x: 7, y: 7, alive: true },
      { name: 'Bandit', kind: 'foe', x: 3, y: 3, alive: false },
    ],
  };
  it('flags dead actors, false adjacency and invented entities', () => {
    expect(mapContradictions(cb, 'The Bandit attacks Mira.')).toEqual([
      'dead Bandit acts',
    ]);
    expect(mapContradictions(cb, 'The Wolf stands next to you.')).toEqual([
      'Wolf wrongly adjacent',
    ]);
    expect(mapContradictions(cb, 'An ogre appears.')).toEqual([
      'unknown entity ogre',
    ]);
    expect(
      mapContradictions(
        cb,
        'The Goblin beside you snarls; the Bandit lies still.',
      ),
    ).toEqual([]);
  });
  const tc = (data('tools.json') as ToolCase[])[0]!;
  it('rejects tool calls with coordinates, wrong tool, or bad JSON', () => {
    expect(
      toolCallValid(
        tc,
        JSON.stringify({ name: tc.expectTool, arguments: tc.args }),
      ),
    ).toBe(true);
    expect(
      toolCallValid(
        tc,
        JSON.stringify({
          name: 'move_token',
          arguments: { tokenId: 't', x: 1, y: 2 },
        }),
      ),
    ).toBe(false);
    expect(
      toolCallValid(
        tc,
        JSON.stringify({
          name: 'roll_check',
          arguments: { ability: 'STR', dc: 10 },
        }),
      ),
    ).toBe(false);
    expect(toolCallValid(tc, 'not json')).toBe(false);
  });
});

describe('runner', () => {
  it('passes the recorded fixture offline and is reproducible for a fixed seed', async () => {
    const a = await run('recorded.json', 7);
    expect(a.passed).toBe(true);
    expect(a.note).toMatch(/too small for statistical claims/);
    expect(await run('recorded.json', 7)).toEqual(a);
  });
  it('fails the deliberately bad fixture suite by suite', async () => {
    const r = await run('recorded-failing.json');
    expect(r.passed).toBe(false);
    expect(Object.values(r.suites).every((s) => !s.pass)).toBe(true);
  });
  it('errors loudly on a fixture gap', async () => {
    await expect(
      runEval(
        async () => {
          throw new Error('gap');
        },
        { mode: 'recorded', endpointProfileId: 'x', modelName: 'x' },
      ),
    ).rejects.toThrow('gap');
  });
});

describe('live mode guard', () => {
  it('requires https unless the exact host is allowed', () => {
    expect(() => checkLiveUrl('http://localhost:11434/v1', '')).toThrow(
      /LLM_ALLOW_LOCAL_HOSTS/,
    );
    expect(
      checkLiveUrl('http://localhost:11434/v1', 'localhost:11434').hostname,
    ).toBe('localhost');
    expect(checkLiveUrl('https://api.example.com/v1', '').hostname).toBe(
      'api.example.com',
    );
  });

  it('bare host allows only ports 80 and 443; host:port allows only that port', () => {
    expect(() =>
      checkLiveUrl('http://172.31.25.75:9999/v1', '172.31.25.75'),
    ).toThrow(/LLM_ALLOW_LOCAL_HOSTS/);
    expect(() =>
      checkLiveUrl('http://172.31.25.75:8080/v1', '172.31.25.75'),
    ).toThrow(/LLM_ALLOW_LOCAL_HOSTS/);
    expect(
      checkLiveUrl('http://172.31.25.75/v1', '172.31.25.75').hostname,
    ).toBe('172.31.25.75');
    expect(() =>
      checkLiveUrl('http://172.31.25.75:8080/v1', '172.31.25.75:8081'),
    ).toThrow(/LLM_ALLOW_LOCAL_HOSTS/);
    expect(
      checkLiveUrl('http://172.31.25.75:8080/v1', '172.31.25.75:8080').hostname,
    ).toBe('172.31.25.75');
  });

  it('matches the egress guard entry rule for bracketed IPv6 and case', () => {
    expect(checkLiveUrl('http://[::1]:8080/v1', ' [::1]:8080 ').hostname).toBe(
      '[::1]',
    );
    expect(() => checkLiveUrl('http://[::1]:9090/v1', '[::1]:8080')).toThrow(
      /LLM_ALLOW_LOCAL_HOSTS/,
    );
    expect(
      checkLiveUrl('http://LOCALHOST:11434/v1', 'localhost:11434').hostname,
    ).toBe('localhost');
  });
});

describe('live mode', () => {
  it('runs against a configured endpoint and stores the record under the profile id', async () => {
    const seeds: number[] = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        seeds.push(JSON.parse(body).seed);
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            choices: [{ message: { content: 'DM discretion.' } }],
          }),
        );
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    process.env.LLM_ALLOW_LOCAL_HOSTS = `127.0.0.1:${port}`;
    try {
      const out = join(mkdtempSync(join(tmpdir(), 'eval-')), 'rec.json');
      const { record, path } = await runLiveAndStore({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        model: 'local-m',
        profile: 'ep-42',
        seed: 3,
        out,
      });
      const stored = JSON.parse(readFileSync(path, 'utf8'));
      expect(stored).toMatchObject({
        mode: 'live',
        endpointProfileId: 'ep-42',
        model: 'local-m',
        seed: 3,
      });
      expect(record.passed).toBe(false); // canned non-answers must not pass
      expect(new Set(seeds).size).toBeGreaterThan(100); // distinct fixed per-case seeds sent
    } finally {
      delete process.env.LLM_ALLOW_LOCAL_HOSTS;
      server.close();
    }
  });
});
