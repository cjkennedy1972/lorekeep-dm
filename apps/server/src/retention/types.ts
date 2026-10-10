import type { Pool } from 'pg';
import type { ObjectStore } from '../storage/objectStore.js';

/** Counts and ids only: never emit emails, display names or text. */
export type SweepLog = (entry: Record<string, string | number>) => void;
export interface JobContext {
  db: Pick<Pool, 'query'>;
  store: ObjectStore;
  now: Date;
  log: SweepLog;
  /** Evicts a live in-process Room (drain + lease release) before its session is scrubbed. */
  drainRoom?: (sessionId: string) => Promise<void>;
}

/** Legal-hold stub (ADR-017): a held item is skipped and an audit row is written. */
export async function skipIfHeld(
  ctx: JobContext,
  job: string,
  kind: 'account' | 'export' | 'session',
  id: string,
): Promise<boolean> {
  const held = await ctx.db.query(
    'SELECT 1 FROM legal_holds WHERE kind=$1 AND item_id=$2',
    [kind, id],
  );
  if (!held.rowCount) return false;
  await ctx.db.query(
    "INSERT INTO retention_audit(job,item_kind,item_id,action) VALUES($1,$2,$3,'skipped_legal_hold')",
    [job, kind, id],
  );
  ctx.log({ job, event: 'skipped_legal_hold', kind, id });
  return true;
}
