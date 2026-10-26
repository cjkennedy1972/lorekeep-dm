import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  LlmAdapter,
  LlmChunk,
  LlmRequest,
} from '../../src/llm/adapter.js';
import { ProductionSoloTurnRunner } from '../../src/room/productionTurnRunner.js';
import { deleteTestSessions } from './testCleanup.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL required');
const ADVENTURE = 'adventure:01-hollow-under-marrowfell';
let db: Pool;
let dir: string;
const accountIds: string[] = [];
const sessionIds: string[] = [];

async function narrationRequest(
  combatRoom: Record<string, unknown>,
  extra: {
    combatNarration?: boolean;
    text?: string;
    displayName?: string;
    boundary?: string;
    sceneId?: string;
  } = {},
) {
  const accountId = randomUUID();
  await db.query(
    `INSERT INTO accounts(id,email,password_hash,display_name,status,is_adult,age_checked_at,terms_version,terms_accepted_at) VALUES($1,$2,'hash','Solo','active',true,now(),'v1',now())`,
    [accountId, `${accountId}@example.test`],
  );
  accountIds.push(accountId);
  if (extra.boundary)
    await db.query(
      'UPDATE accounts SET content_lines=$2, content_veils=$2 WHERE id=$1',
      [accountId, [extra.boundary]],
    );
  const sessionId = randomUUID();
  await db.query(
    'INSERT INTO sessions(id,owner_account_id,name,adventure_id) VALUES($1,$2,$3,$4)',
    [sessionId, accountId, 'Narration table', ADVENTURE],
  );
  await db.query(
    `INSERT INTO events(session_id,seq,turn_id,type,payload) VALUES($1,1,$1,'SeatJoined',$2)`,
    [sessionId, JSON.stringify({ accountId, displayName: 'Solo' })],
  );
  sessionIds.push(sessionId);
  const calls: LlmRequest[] = [];
  const adapter: LlmAdapter = {
    capabilities: () => ({
      streaming: true,
      nativeTools: true,
      jsonSchema: true,
    }),
    probe: async () => true,
    async *complete(request: LlmRequest) {
      calls.push(request);
      yield { type: 'text', delta: 'The turn resolves.' } as LlmChunk;
    },
  };
  const runner = new ProductionSoloTurnRunner(
    db,
    undefined,
    'record',
    join(dir, `${sessionId}.ndjson`),
    adapter,
    true,
    false,
    undefined,
    async () => true,
  );
  const result = await runner.run(
    {
      sessionId,
      accountId,
      actionId: randomUUID(),
      text: extra.text ?? 'Narrate.',
      ...(extra.combatNarration ? { combatNarration: true } : {}),
      playerName: extra.displayName,
      state: {
        lastNarration: 'Earlier tale.',
        lastPlayerText: 'Earlier ask.',
        ...(extra.sceneId ? { sceneId: extra.sceneId } : {}),
        ...(extra.displayName
          ? {
              characters: {
                [accountId]: {
                  id: 'ent_aria',
                  name: extra.displayName,
                  speciesId: 'srd:species/human',
                  classId: 'srd:class/fighter',
                  backgroundId: 'srd:background/soldier',
                  level: 1,
                  abilities: {
                    str: 15,
                    dex: 12,
                    con: 13,
                    int: 10,
                    wis: 11,
                    cha: 8,
                  },
                  proficiencies: { skills: [], saves: [], tools: [] },
                  equipment: [],
                  spellsKnown: [],
                  spellsPrepared: [],
                  slots: {},
                  hp: { current: 10, max: 10, temp: 0 },
                  conditions: [],
                },
              },
            }
          : {}),
        combatRoom,
      },
    },
    () => undefined,
  );
  narrationResult = result;
  return JSON.stringify(calls);
}
let narrationResult: { state: unknown } | undefined;

// Recent turns reach the prompt base64-encoded.
const EARLIER = Buffer.from('Earlier tale.').toString('base64');

const combatRoom = (activeEntityId: string, ended = false) => ({
  ended,
  entities: [
    { id: 'ent_aria', hp: 10, maxHp: 10 },
    { id: 'ent_ambusher_9', hp: 5, maxHp: 5, hidden: true },
  ],
  combat: {
    round: 1,
    resources: {},
    activeEntityId,
    initiative: [{ entityId: 'ent_aria' }, { entityId: 'ent_ambusher_9' }],
  },
});

beforeAll(async () => {
  db = new Pool({ connectionString: databaseUrl });
  dir = await mkdtemp(join(tmpdir(), 'narration-actor-'));
});
afterAll(async () => {
  await deleteTestSessions(db, sessionIds);
  for (const id of accountIds)
    await db.query('DELETE FROM accounts WHERE id=$1', [id]);
  await db.end();
  await rm(dir, { recursive: true, force: true });
});

describe('combat narration request through ProductionSoloTurnRunner', () => {
  it('does not name a hidden next combatant as the active actor', async () => {
    const hidden = await narrationRequest(combatRoom('ent_ambusher_9'));
    expect(hidden).not.toContain('ent_ambusher_9');
    const visible = await narrationRequest(combatRoom('ent_aria'));
    expect(visible).toContain('Active combatant: ent_aria');
  });

  it('keeps prior turns once combat has ended', async () => {
    expect(await narrationRequest(combatRoom('ent_aria'))).not.toContain(
      EARLIER,
    );
    expect(await narrationRequest(combatRoom('ent_aria', true))).toContain(
      EARLIER,
    );
  });

  it('carries only engine handles and keeps post-combat continuity clean', async () => {
    const raw = await narrationRequest(combatRoom('ent_aria'), {
      combatNarration: true,
      displayName: 'Zorbo the Display',
      text: '[Combat resolved by the engine; narrate it, do not change it] {"type":"HpChanged","entityId":"ent_aria","delta":-3,"hp":7}',
    });
    // Prompt data blocks are base64; check the decoded text as well as the wire form.
    const request = [
      raw,
      ...[...raw.matchAll(/encoding=base64>>>\\+n([A-Za-z0-9+/=]+)\\+n/g)].map(
        (match) => Buffer.from(match[1]!, 'base64').toString('utf8'),
      ),
    ].join('\n');
    expect(request).toContain('"type":"HpChanged"');
    for (const leaked of ['Zorbo', 'Earlier', 'Narrate.'])
      expect(request).not.toContain(leaked);
    expect(raw).not.toContain(EARLIER);
    expect(narrationResult!.state).toMatchObject({
      lastNarration: 'Earlier tale.',
      lastPlayerText: 'Earlier ask.',
    });
  });

  it('omits player-typed boundaries, scene text and next scenes from the combat request', async () => {
    const boundary = 'no-spiders-xyzzy';
    const decode = (raw: string) =>
      [
        raw,
        ...[
          ...raw.matchAll(/encoding=base64>>>\\+n([A-Za-z0-9+/=]+)\\+n/g),
        ].map((match) => Buffer.from(match[1]!, 'base64').toString('utf8')),
      ].join('\n');
    const extra = { boundary, sceneId: 'scene-marowfell-well' };
    const combat = decode(
      await narrationRequest(combatRoom('ent_aria'), {
        ...extra,
        combatNarration: true,
      }),
    );
    for (const leaked of [
      boundary,
      'dead lamps',
      'Marrowfell Well',
      'scene-broken-gatehouse',
      'Broken Gatehouse',
    ])
      expect(combat).not.toContain(leaked);
    // Control: the same seed does reach an ordinary (non-combat) turn.
    const ordinary = decode(
      await narrationRequest(combatRoom('ent_aria', true), extra),
    );
    expect(ordinary).toContain(boundary);
    expect(ordinary).toContain('Broken Gatehouse');
  });
});
