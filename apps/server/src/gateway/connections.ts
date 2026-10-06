import type { Pool } from 'pg';
import type { WebSocket } from 'ws';

export const REVOKED_CODE = 4401;
/** Open sockets keyed by the auth session that minted their ticket. `sweep` closes any whose session/account is no longer valid. */
export class ConnectionRegistry {
  private readonly sockets = new Map<WebSocket, string>();
  private lastSweep = 0;
  constructor(private readonly db: Pick<Pool, 'query'>) {}
  add(ws: WebSocket, authTokenHash: string): void {
    this.sockets.set(ws, authTokenHash);
  }
  remove(ws: WebSocket): void {
    this.sockets.delete(ws);
  }
  get size(): number {
    return this.sockets.size;
  }
  async sweep(): Promise<void> {
    this.lastSweep = Date.now();
    const hashes = [...new Set(this.sockets.values())];
    if (!hashes.length) return;
    const valid = new Set(
      (
        await this.db.query<{ token_hash: string }>(
          `SELECT s.token_hash FROM auth_sessions s JOIN accounts a ON a.id=s.account_id
            WHERE s.token_hash=ANY($1::text[]) AND a.status='active'
            AND s.expires_at>now() AND s.absolute_expires_at>now()`,
          [hashes],
        )
      ).rows.map((r) => r.token_hash),
    );
    for (const [ws, hash] of this.sockets)
      if (!valid.has(hash)) {
        this.sockets.delete(ws);
        ws.close(REVOKED_CODE, 'session revoked');
      }
  }
  /** Cheap per-message recheck: at most one sweep query per interval. */
  async sweepIfStale(maxAgeMs = 2000): Promise<void> {
    if (Date.now() - this.lastSweep >= maxAgeMs) await this.sweep();
  }
}
