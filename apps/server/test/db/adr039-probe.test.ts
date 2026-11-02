import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RegistryMemory } from '../../src/dm/memory.js';
import { SeatCharacterRepository } from '../../src/persistence/seatCharacters.js';
import { LocalObjectStore } from '../../src/storage/objectStore.js';
import { runSweep } from '../../src/retention/sweeper.js';

let db: Pool;
let dir: string;
const q = async (sql: string, p: unknown[] = []) =>
  (await db.query(sql, p)).rows;
const tok = () => randomBytes(24).toString('base64url');
const repo = () => new SeatCharacterRepository(db);

async function account(name: string) {
  const id = randomUUID();
  await q(
    "INSERT INTO accounts(id,email,password_hash,display_name,status,is_adult,age_checked_at,terms_version,terms_accepted_at) VALUES($1,$2,'h',$3,'active',true,now(),'v1',now())",
    [id, `${id}@example.test`, name],
  );
  return id;
}
async function character(accountId: string, name: string) {
  const id = randomUUID();
  await q(
    'INSERT INTO account_characters(id,account_id,character) VALUES($1,$2,$3)',
    [id, accountId, { id, name }],
  );
  return id;
}
async function session(owner: string) {
  const id = randomUUID();
  await q(
    'INSERT INTO sessions(id,owner_account_id,name,adventure_id) VALUES($1,$2,$3,$4)',
    [id, owner, 'probe', 'adventure:01-hollow-under-marrowfell'],
  );
  return id;
}
async function bind(
  s: string,
  accountId: string,
  characterId: string,
  name: string,
  status: 'active' | 'released' = 'active',
) {
  const token = tok();
  await q(
    `INSERT INTO session_seat_characters(session_id,seat_id,account_id,character_id,character_revision,character_snapshot,binding_status,unbound_at)
     VALUES($1,$2,$3,$4,1,$5,$6,CASE WHEN $6='active' THEN NULL ELSE now() END)`,
    [
      s,
      randomUUID(),
      accountId,
      characterId,
      { id: characterId, name },
      status,
    ],
  );
  await q(
    'INSERT INTO session_character_tokens(session_id,character_id,token) VALUES($1,$2,$3)',
    [s, characterId, token],
  );
  return token;
}
async function summary(s: string, text: string, indexFor: string[] = []) {
  const [{ id }] = await q(
    'INSERT INTO scene_summaries(session_id,scene_id,summary) VALUES($1,$2,$3) RETURNING id',
    [s, `scene-${randomUUID()}`, text],
  );
  for (const c of indexFor)
    await q(
      "INSERT INTO derived_memory_character_refs(session_id,character_id,row_kind,row_id) VALUES($1,$2,'scene_summary',$3)",
      [s, c, id],
    );
  return id as string;
}
async function entry(
  s: string,
  o: {
    entityId: string;
    version?: number;
    name?: string;
    payload?: unknown;
    searchDoc?: string;
    supersedes?: string | null;
    index?: string[];
  },
) {
  const version = o.version ?? 1;
  const [{ id }] = await q(
    `INSERT INTO registry_entries(session_id,entity_type,entity_id,version,name,payload,search_document,supersedes_id)
     VALUES($1,'npc',$2,$3,$4,$5,$6,$7) RETURNING id`,
    [
      s,
      o.entityId,
      version,
      o.name ?? 'Npc',
      o.payload ?? {},
      o.searchDoc ?? '',
      o.supersedes ?? null,
    ],
  );
  for (const c of o.index ?? [])
    await q(
      "INSERT INTO derived_memory_character_refs(session_id,character_id,row_kind,row_id) VALUES($1,$2,'registry_entry',$3)",
      [s, c, id],
    );
  return id as string;
}
async function fact(
  entryId: string,
  text: string,
  supersedes: string | null = null,
) {
  const [{ id }] = await q(
    'INSERT INTO registry_facts(entry_id,fact,supersedes_id) VALUES($1,$2,$3) RETURNING id',
    [entryId, text, supersedes],
  );
  return id as string;
}
async function setHold(s: string) {
  await q("INSERT INTO legal_holds(kind,item_id) VALUES('session',$1)", [s]);
}
/** Every text field a derived row can carry, for the session. */
async function textRows(s: string) {
  return q(
    `SELECT 'summary' k, id::text id, summary t FROM scene_summaries WHERE session_id=$1
     UNION ALL SELECT 'entry', id::text, concat_ws(' ',name,array_to_string(aliases,' '),payload::text,search_document) FROM registry_entries WHERE session_id=$1
     UNION ALL SELECT 'fact', f.id::text, f.fact FROM registry_facts f JOIN registry_entries e ON e.id=f.entry_id WHERE e.session_id=$1`,
    [s],
  );
}
async function leftovers(s: string, needles: string[]) {
  return (await textRows(s)).filter((r: { t: string }) =>
    needles.some((n) => r.t.toLowerCase().includes(n.toLowerCase())),
  );
}
const tokenCount = async (token: string) =>
  (await q('SELECT 1 FROM session_character_tokens WHERE token=$1', [token]))
    .length;

beforeAll(async () => {
  db = new Pool({ connectionString: process.env.DATABASE_URL });
  dir = await mkdtemp(join(tmpdir(), 'adr039-probe-'));
  await db.query(
    'UPDATE derived_memory_reconciliation_state SET complete=true WHERE singleton=true',
  );
});
afterAll(async () => {
  await db.end();
  await rm(dir, { recursive: true, force: true });
});

describe('ADR-039 step 3 probe (f2b5c15e)', () => {
  it('P1 account deletion: shared session keeps unrelated characters and NPCs', async () => {
    const gone = await account('Gone');
    const co = await account('Co');
    const brann = await character(gone, 'Brann');
    const ash = await character(co, 'Ash');
    const s = await session(co);
    const tB = await bind(s, gone, brann, 'Brann');
    const tA = await bind(s, co, ash, 'Ash');
    const sumB = await summary(
      s,
      `Brann said "I am Brann, open the gate" ${tB}`,
      [brann],
    );
    const sumA = await summary(s, `Ash waits ${tA}`, [ash]);
    const sumN = await summary(s, 'Mira trades maps at the river.');
    const eB = await entry(s, {
      entityId: 'brann-ref',
      name: 'Brann',
      payload: { role: tB, quote: 'I am Brann' },
      searchDoc: `Brann ${tB}`,
      index: [brann],
    });
    await fact(eB, `Brann ${tB} agreed`);
    const eN = await entry(s, {
      entityId: 'npc_mira',
      name: 'Mira',
      searchDoc: 'Mira trades maps',
    });
    const fN = await fact(eN, 'Mira trades maps at the river market');
    await q(
      "UPDATE accounts SET status='deleting', deletion_requested_at=now() WHERE id=$1",
      [gone],
    );
    const result = await runSweep(db, {
      store: new LocalObjectStore(dir),
      log: () => {},
    });
    expect(result?.accounts.deleted).toBeGreaterThanOrEqual(1);
    expect(await leftovers(s, ['Brann', tB])).toEqual([]);
    expect(await tokenCount(tB)).toBe(0);
    expect(await q('SELECT 1 FROM accounts WHERE id=$1', [gone])).toHaveLength(
      0,
    );
    const survivors = (await textRows(s)).map((r: { id: string }) => r.id);
    expect(survivors).toEqual(
      expect.arrayContaining([sumA, sumN, eN, fN].map(String)),
    );
    expect(await tokenCount(tA)).toBe(1);
    void sumB;
  }, 60_000);

  it('P2 character deletion with released binding: only that character indexed rows go', async () => {
    const gone = await account('Gone2');
    const co = await account('Co2');
    const brann = await character(gone, 'Brann');
    const ash = await character(co, 'Ash');
    const s = await session(co);
    const tB = await bind(s, gone, brann, 'Brann', 'released');
    const tA = await bind(s, co, ash, 'Ash');
    await summary(s, `Brann ${tB} left`, [brann]);
    const keep = await summary(s, `Ash ${tA} stays`, [ash]);
    const eB = await entry(s, {
      entityId: 'b',
      name: 'Brann',
      searchDoc: `Brann ${tB}`,
      index: [brann],
    });
    await fact(eB, `Brann ${tB} oath`);
    const eN = await entry(s, {
      entityId: 'npc_mira',
      name: 'Mira',
      searchDoc: 'Mira',
    });
    await fact(eN, 'Mira sells rope');
    expect(await repo().deleteOwnedCharacter(gone, brann)).toBe(true);
    expect(await leftovers(s, ['Brann', tB])).toEqual([]);
    expect(await tokenCount(tB)).toBe(0);
    expect((await textRows(s)).map((r: { id: string }) => r.id)).toEqual(
      expect.arrayContaining([keep, eN].map(String)),
    );
  });

  // Supersession: each case uses its own session and character.
  const chainCase = async () => {
    const gone = await account('Chain');
    const brann = await character(gone, 'Brann');
    const s = await session(gone);
    const tB = await bind(s, gone, brann, 'Brann', 'released');
    return { gone, brann, s, tB };
  };

  it('P3a supersession: targeted middle row', async () => {
    const { gone, brann, s, tB } = await chainCase();
    const v1 = await entry(s, { entityId: 'guard', version: 1, name: 'Guard' });
    const v2 = await entry(s, {
      entityId: 'guard',
      version: 2,
      name: 'Guard',
      supersedes: v1,
      searchDoc: tB,
      index: [brann],
    });
    const v3 = await entry(s, {
      entityId: 'guard',
      version: 3,
      name: 'Guard',
      supersedes: v2,
    });
    await q('UPDATE registry_entries SET superseded_by=$2 WHERE id=$1', [
      v1,
      v2,
    ]);
    await q('UPDATE registry_entries SET superseded_by=$2 WHERE id=$1', [
      v2,
      v3,
    ]);
    expect(await repo().deleteOwnedCharacter(gone, brann)).toBe(true);
    const rows = await q(
      'SELECT id,supersedes_id,superseded_by,version FROM registry_entries WHERE session_id=$1 ORDER BY id',
      [s],
    );
    expect(rows.map((r: { id: string }) => r.id)).toEqual([v1, v3].map(String));
    expect(
      rows.find((r: { id: string }) => r.id === String(v3))?.supersedes_id,
    ).toBe(String(v1));
    expect(
      rows.find((r: { id: string }) => r.id === String(v1))?.superseded_by,
    ).toBeNull();
    expect(await leftovers(s, [tB])).toEqual([]);
  });

  it('P3b supersession: targeted head row', async () => {
    const { gone, brann, s, tB } = await chainCase();
    const v1 = await entry(s, { entityId: 'guard', version: 1, name: 'Guard' });
    const v2 = await entry(s, {
      entityId: 'guard',
      version: 2,
      name: 'Guard',
      supersedes: v1,
      searchDoc: tB,
      index: [brann],
    });
    await q('UPDATE registry_entries SET superseded_by=$2 WHERE id=$1', [
      v1,
      v2,
    ]);
    expect(await repo().deleteOwnedCharacter(gone, brann)).toBe(true);
    const rows = await q(
      'SELECT id,superseded_by FROM registry_entries WHERE session_id=$1',
      [s],
    );
    expect(rows).toEqual([{ id: String(v1), superseded_by: null }]);
    expect(await leftovers(s, [tB])).toEqual([]);
  });

  it('P3c supersession: targeted tail row', async () => {
    const { gone, brann, s, tB } = await chainCase();
    const v1 = await entry(s, {
      entityId: 'guard',
      version: 1,
      name: 'Guard',
      searchDoc: tB,
      index: [brann],
    });
    const v2 = await entry(s, {
      entityId: 'guard',
      version: 2,
      name: 'Guard',
      supersedes: v1,
    });
    await q('UPDATE registry_entries SET superseded_by=$2 WHERE id=$1', [
      v1,
      v2,
    ]);
    expect(await repo().deleteOwnedCharacter(gone, brann)).toBe(true);
    const rows = await q(
      'SELECT id,version,supersedes_id,superseded_by FROM registry_entries WHERE session_id=$1',
      [s],
    );
    expect(rows).toEqual([
      { id: String(v2), version: 1, supersedes_id: null, superseded_by: null },
    ]);
    expect(await leftovers(s, [tB])).toEqual([]);
  });

  it('P3d cross-version fact supersession does not dangle or block deletion', async () => {
    const { gone, brann, s, tB } = await chainCase();
    const v1 = await entry(s, {
      entityId: 'guard',
      version: 1,
      name: 'Guard',
      searchDoc: tB,
      index: [brann],
    });
    const f1 = await fact(v1, `Guard ${tB} oath`);
    const v2 = await entry(s, {
      entityId: 'guard',
      version: 2,
      name: 'Guard',
      supersedes: v1,
    });
    const f2 = await fact(v2, 'Guard keeps the oath', f1);
    expect(await repo().deleteOwnedCharacter(gone, brann)).toBe(true);
    expect(await leftovers(s, [tB])).toEqual([]);
    expect(
      await q('SELECT fact,supersedes_id FROM registry_facts WHERE id=$1', [
        f2,
      ]),
    ).toEqual([{ fact: 'Guard keeps the oath', supersedes_id: null }]);
  });

  it('P4 held sessions (token mapping only, and indexed rows) are untouched and report HELD', async () => {
    const gone = await account('Held');
    const brann = await character(gone, 'Brann');
    const s = await session(gone);
    const tB = await bind(s, gone, brann, 'Brann', 'released');
    await setHold(s);
    await expect(
      repo().deleteOwnedCharacter(gone, brann),
    ).rejects.toMatchObject({ code: 'SESSION_HELD' });
    expect(await tokenCount(tB)).toBe(1);
    expect(
      await q('SELECT 1 FROM account_characters WHERE id=$1', [brann]),
    ).toHaveLength(1);

    // Indexed rows in a held session survive an account deletion attempt.
    const gone2 = await account('Held2');
    const b2 = await character(gone2, 'Brann');
    const s2 = await session(gone2);
    const t2 = await bind(s2, gone2, b2, 'Brann', 'released');
    const sum = await summary(s2, `Brann ${t2} held`, [b2]);
    await setHold(s2);
    await q(
      "UPDATE accounts SET status='deleting', deletion_requested_at=now() WHERE id=$1",
      [gone2],
    );
    const result = await runSweep(db, {
      store: new LocalObjectStore(dir),
      log: () => {},
    });
    expect(result?.accounts.held).toBeGreaterThanOrEqual(1);
    expect(await q('SELECT 1 FROM accounts WHERE id=$1', [gone2])).toHaveLength(
      1,
    );
    expect(
      await q('SELECT id FROM scene_summaries WHERE id=$1', [sum]),
    ).toHaveLength(1);
    expect(await tokenCount(t2)).toBe(1);
  }, 60_000);

  it('P5 coverage-incomplete sessions fail closed with no mutation', async () => {
    const gone = await account('Cov');
    const brann = await character(gone, 'Brann');
    const s = await session(gone);
    const tB = await bind(s, gone, brann, 'Brann', 'released');
    const sum = await summary(s, `Brann ${tB} unindexed`); // token present, no ref row
    await db.query(
      'UPDATE derived_memory_reconciliation_state SET complete=false WHERE singleton=true',
    );
    await expect(repo().deleteOwnedCharacter(gone, brann)).rejects.toThrow(
      /coverage is unverified/,
    );
    await db.query(
      'UPDATE derived_memory_reconciliation_state SET complete=true WHERE singleton=true',
    );
    await expect(
      repo().deleteOwnedCharacter(gone, brann),
    ).rejects.toMatchObject({
      code: 'SESSION_HELD',
    });
    expect(
      await q('SELECT 1 FROM scene_summaries WHERE id=$1', [sum]),
    ).toHaveLength(1);
    expect(await tokenCount(tB)).toBe(1);
    expect(
      await q('SELECT 1 FROM account_characters WHERE id=$1', [brann]),
    ).toHaveLength(1);
  });

  it('P6 mid-run failure rolls back fully; rerun is resumable and a repeat is idempotent', async () => {
    const gone = await account('Resume');
    const brann = await character(gone, 'Brann');
    const s1 = await session(gone);
    const s2 = await session(gone);
    const t1 = await bind(s1, gone, brann, 'Brann', 'released');
    const t2 = await bind(s2, gone, brann, 'Brann', 'released');
    await summary(s1, `Brann ${t1}`, [brann]);
    await summary(s2, `Brann ${t2}`, [brann]);
    // A live foreign lease on s2 makes the fence step fail after s1 was resolved.
    await q(
      "INSERT INTO session_lease(session_id,node_id,expires_at,epoch) VALUES($1,'other-node',clock_timestamp()+interval '1 hour',1)",
      [s2],
    );
    await expect(
      repo().deleteOwnedCharacter(gone, brann),
    ).rejects.toMatchObject({ code: 'SESSION_BUSY' });
    expect(await tokenCount(t1)).toBe(1);
    expect(await tokenCount(t2)).toBe(1);
    expect(
      await q(
        'SELECT count(*)::int n FROM scene_summaries WHERE session_id=$1',
        [s1],
      ),
    ).toEqual([{ n: 1 }]);
    await q(
      'UPDATE session_lease SET expires_at=clock_timestamp() WHERE session_id=$1',
      [s2],
    );
    expect(await repo().deleteOwnedCharacter(gone, brann)).toBe(true);
    expect(await leftovers(s1, [t1])).toEqual([]);
    expect(await leftovers(s2, [t2])).toEqual([]);
    expect(await repo().deleteOwnedCharacter(gone, brann)).toBe(false);
  });

  it('P7 concurrent hold creation vs deletion: no partial scrub', async () => {
    const gone = await account('Race');
    const brann = await character(gone, 'Brann');
    const s = await session(gone);
    const t = await bind(s, gone, brann, 'Brann', 'released');
    await summary(s, `Brann ${t}`, [brann]);
    const holder = await db.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(
        "INSERT INTO legal_holds(kind,item_id) VALUES('session',$1)",
        [s],
      );
      const deletion = repo().deleteOwnedCharacter(gone, brann);
      await new Promise((r) => setTimeout(r, 300));
      await holder.query('COMMIT');
      await expect(deletion).rejects.toMatchObject({ code: 'SESSION_HELD' });
    } finally {
      holder.release();
    }
    expect(await tokenCount(t)).toBe(1);
    expect(await leftovers(s, [`Brann ${t}`, t])).toHaveLength(1);
    await q('DELETE FROM legal_holds WHERE item_id=$1', [s]);
  });

  it('P8 character deleted while a summarizer call is in flight cannot write rows afterwards', async () => {
    const gone = await account('Inflight');
    const brann = await character(gone, 'Brann');
    const s = await session(gone);
    const t = await bind(s, gone, brann, 'Brann', 'released');
    await q(
      "INSERT INTO session_lease(session_id,node_id,expires_at,epoch) VALUES($1,'room',clock_timestamp()-interval '1 second',1)",
      [s],
    );
    const capturedEpoch = Number(
      (await q('SELECT epoch FROM session_lease WHERE session_id=$1', [s]))[0]
        .epoch,
    );
    let finishModel!: () => void;
    let markStarted!: () => void;
    const modelGate = new Promise<void>((resolve) => {
      finishModel = resolve;
    });
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const memory = new RegistryMemory(db);
    const lateCall = (async () => {
      markStarted(); // The call is in flight while its upstream summarizer is pending.
      await modelGate;
      return memory.closeScene(
        s,
        'late-scene',
        `Brann met the guard. ${t}`,
        [],
        null,
        {},
        capturedEpoch,
      );
    })();
    await started;
    expect(await repo().deleteOwnedCharacter(gone, brann)).toBe(true);
    finishModel();
    await expect(lateCall).rejects.toThrow(/lease changed/i);
    expect(await leftovers(s, ['Brann', t])).toEqual([]);
    expect(
      await q(
        "SELECT 1 FROM scene_summaries WHERE session_id=$1 AND scene_id='late-scene'",
        [s],
      ),
    ).toHaveLength(0);
  });

  it('P10 failure after lineage repair rolls back every deletion change', async () => {
    const gone = await account('Rollback');
    const brann = await character(gone, 'Brann');
    const s = await session(gone);
    const t = await bind(s, gone, brann, 'Brann', 'released');
    const v1 = await entry(s, {
      entityId: 'rollback-target',
      name: 'Guard',
      searchDoc: t,
      index: [brann],
    });
    const f1 = await fact(v1, `Guard ${t} keeps the old oath`);
    const v2 = await entry(s, {
      entityId: 'rollback-target',
      version: 2,
      name: 'Guard',
      supersedes: v1,
    });
    const f2 = await fact(v2, 'Guard keeps the new oath', f1);
    await q(`
      CREATE FUNCTION adr039_fail_registry_delete() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.entity_id='rollback-target' THEN
          RAISE EXCEPTION 'injected ADR-039 deletion failure';
        END IF;
        RETURN OLD;
      END $$;
      CREATE TRIGGER adr039_fail_registry_delete BEFORE DELETE ON registry_entries
      FOR EACH ROW EXECUTE FUNCTION adr039_fail_registry_delete();
    `);
    try {
      await expect(repo().deleteOwnedCharacter(gone, brann)).rejects.toThrow(
        'injected ADR-039 deletion failure',
      );
      expect(
        await q(
          'SELECT id FROM registry_entries WHERE id=ANY($1::bigint[]) ORDER BY id',
          [[v1, v2]],
        ),
      ).toEqual([{ id: v1 }, { id: v2 }]);
      expect(
        await q(
          'SELECT id,supersedes_id FROM registry_facts WHERE id=ANY($1::bigint[]) ORDER BY id',
          [[f1, f2]],
        ),
      ).toEqual([
        { id: f1, supersedes_id: null },
        { id: f2, supersedes_id: f1 },
      ]);
      expect(await tokenCount(t)).toBe(1);
      expect(
        await q(
          'SELECT 1 FROM derived_memory_character_refs WHERE session_id=$1 AND character_id=$2',
          [s, brann],
        ),
      ).toHaveLength(1);
      expect(
        await q('SELECT 1 FROM account_characters WHERE id=$1', [brann]),
      ).toHaveLength(1);
      expect(
        await q('SELECT 1 FROM session_lease WHERE session_id=$1', [s]),
      ).toHaveLength(0);
    } finally {
      await q(
        'DROP TRIGGER IF EXISTS adr039_fail_registry_delete ON registry_entries',
      );
      await q('DROP FUNCTION IF EXISTS adr039_fail_registry_delete()');
    }
  });

  it('P9 released bindings still screen identities by their stored token', async () => {
    const gone = await account('Released identity');
    const brann = await character(gone, 'Brann');
    const s = await session(gone);
    const t = await bind(s, gone, brann, 'Brann', 'released');
    await new RegistryMemory(db).closeScene(
      s,
      'released-identity',
      'Brann met the guard by the old road.',
      [],
      null,
      {},
      null,
    );
    const rows = await q(
      "SELECT summary FROM scene_summaries WHERE session_id=$1 AND scene_id='released-identity'",
      [s],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].summary).not.toContain('Brann');
    expect(rows[0].summary).toContain(t);
    expect(
      await q(
        "SELECT 1 FROM derived_memory_character_refs WHERE session_id=$1 AND character_id=$2 AND row_kind='scene_summary'",
        [s, brann],
      ),
    ).toHaveLength(1);
  });
});
