import type { Pool } from 'pg';

export interface Lease {
  sessionId: string;
  nodeId: string;
  epoch: number;
  expiresAt: Date;
}

export interface LeaseOptions {
  ttlMs?: number;
  heartbeatIntervalMs?: number;
}

export class SessionLease {
  readonly ttlMs: number;
  readonly heartbeatIntervalMs: number;

  constructor(
    private readonly pool: Pool,
    options: LeaseOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? 30_000;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 10_000;
    if (
      !Number.isSafeInteger(this.ttlMs) ||
      this.ttlMs <= 0 ||
      !Number.isSafeInteger(this.heartbeatIntervalMs) ||
      this.heartbeatIntervalMs <= 0 ||
      this.heartbeatIntervalMs >= this.ttlMs
    ) {
      throw new Error('Lease TTL must exceed a positive heartbeat interval');
    }
  }

  async acquire(sessionId: string, nodeId: string): Promise<Lease | null> {
    if (!nodeId) throw new Error('nodeId is required');
    const result = await this.pool.query<{ epoch: string; expires_at: Date }>(
      `INSERT INTO session_lease(session_id,node_id,expires_at,epoch)
       VALUES ($1,$2,clock_timestamp() + $3::integer * interval '1 millisecond',1)
       ON CONFLICT (session_id) DO UPDATE SET
         node_id = EXCLUDED.node_id,
         expires_at = EXCLUDED.expires_at,
         epoch = session_lease.epoch + 1
       WHERE session_lease.expires_at <= clock_timestamp()
       RETURNING epoch, expires_at`,
      [sessionId, nodeId, this.ttlMs],
    );
    const row = result.rows[0];
    return row
      ? {
          sessionId,
          nodeId,
          epoch: Number(row.epoch),
          expiresAt: row.expires_at,
        }
      : null;
  }

  async renew(lease: Lease): Promise<Lease | null> {
    const result = await this.pool.query<{ expires_at: Date }>(
      `UPDATE session_lease SET expires_at = clock_timestamp() + $4::integer * interval '1 millisecond'
       WHERE session_id=$1 AND node_id=$2 AND epoch=$3 AND expires_at > clock_timestamp()
       RETURNING expires_at`,
      [lease.sessionId, lease.nodeId, lease.epoch, this.ttlMs],
    );
    const row = result.rows[0];
    return row ? { ...lease, expiresAt: row.expires_at } : null;
  }

  async release(lease: Lease): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE session_lease SET node_id='', expires_at=clock_timestamp()
       WHERE session_id=$1 AND node_id=$2 AND epoch=$3 AND expires_at > clock_timestamp()`,
      [lease.sessionId, lease.nodeId, lease.epoch],
    );
    return result.rowCount === 1;
  }
}
