import type { Pool } from 'pg';
import type { WebSocket } from 'ws';

export const REVOKED_CODE = 4401;

export interface SeatReservationResult {
  reserved: boolean;
  takenOver: boolean;
}
/** Open sockets keyed by the auth session that minted their ticket. `sweep` closes any whose session/account is no longer valid. */
export class ConnectionRegistry {
  private readonly sockets = new Map<
    WebSocket,
    {
      authTokenHash: string;
      accountId: string;
      seatKey?: string;
      lastPongAt: number;
    }
  >();
  private readonly seatReservations = new Map<string, WebSocket>();
  private readonly seatSockets = new Map<string, WebSocket>();
  private readonly seatAuthAttempts = new Map<string, number[]>();
  private readonly accountAuthAttempts = new Map<string, number[]>();
  private readonly ipAuthAttempts = new Map<string, number[]>();
  private lastSweep = 0;
  constructor(private readonly db: Pick<Pool, 'query'>) {}
  reserveSeat(
    seatKey: string,
    ws: WebSocket,
    tokenValidated = false,
  ): SeatReservationResult {
    let takenOver = false;
    const current = this.seatSockets.get(seatKey);
    if (current) {
      const details = this.sockets.get(current);
      const live =
        current.readyState === 1 &&
        details !== undefined &&
        Date.now() - details.lastPongAt < 15_000;
      if (live && !tokenValidated) return { reserved: false, takenOver: false };
      takenOver = live && tokenValidated;
      current.close(REVOKED_CODE, 'Seat socket declared lost');
      this.remove(current);
    }
    if (this.seatReservations.has(seatKey))
      return { reserved: false, takenOver: false };
    this.seatReservations.set(seatKey, ws);
    return { reserved: true, takenOver };
  }
  consumeSeatAuthAttempt(seatKey: string, now = Date.now()): boolean {
    const active = (this.seatAuthAttempts.get(seatKey) ?? []).filter(
      (at) => now - at < 60_000,
    );
    if (active.length >= 5) {
      this.seatAuthAttempts.set(seatKey, active);
      return false;
    }
    active.push(now);
    this.seatAuthAttempts.set(seatKey, active);
    return true;
  }
  consumeTransportAuthAttempt(
    accountId: string,
    ipAddress: string,
    now = Date.now(),
  ): boolean {
    const consume = (
      attempts: Map<string, number[]>,
      key: string,
      limit: number,
    ) => {
      const active = (attempts.get(key) ?? []).filter(
        (at) => now - at < 60_000,
      );
      if (active.length >= limit) {
        attempts.set(key, active);
        return false;
      }
      active.push(now);
      attempts.set(key, active);
      return true;
    };
    return (
      consume(this.accountAuthAttempts, accountId, 30) &&
      consume(this.ipAuthAttempts, ipAddress || 'unknown', 120)
    );
  }
  /** Reset in-memory auth throttles between isolated integration-test fixtures. */
  resetAuthAttemptHistory(): void {
    this.seatAuthAttempts.clear();
    this.accountAuthAttempts.clear();
    this.ipAuthAttempts.clear();
  }
  add(
    ws: WebSocket,
    authTokenHash: string,
    seatKey: string,
    accountId: string,
  ): void {
    if (this.seatReservations.get(seatKey) !== ws)
      throw new Error('Seat socket was not reserved');
    this.seatReservations.delete(seatKey);
    this.seatSockets.set(seatKey, ws);
    this.sockets.set(ws, {
      authTokenHash,
      accountId,
      seatKey,
      lastPongAt: Date.now(),
    });
  }
  notifyAccount(accountId: string, frame: unknown): void {
    const serialized = JSON.stringify(frame);
    for (const [ws, details] of this.sockets)
      if (details.accountId === accountId && ws.readyState === 1)
        ws.send(serialized);
  }
  markPong(ws: WebSocket): void {
    const details = this.sockets.get(ws);
    if (details) details.lastPongAt = Date.now();
  }
  hasSeatSocket(seatKey: string): boolean {
    return this.seatSockets.has(seatKey);
  }
  remove(ws: WebSocket): void {
    const details = this.sockets.get(ws);
    this.sockets.delete(ws);
    if (details?.seatKey && this.seatSockets.get(details.seatKey) === ws)
      this.seatSockets.delete(details.seatKey);
    for (const [seatKey, reserved] of this.seatReservations)
      if (reserved === ws) this.seatReservations.delete(seatKey);
  }
  get size(): number {
    return this.sockets.size;
  }
  async sweep(): Promise<void> {
    this.lastSweep = Date.now();
    const hashes = [
      ...new Set(
        [...this.sockets.values()].map((value) => value.authTokenHash),
      ),
    ];
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
    for (const [ws, details] of this.sockets)
      if (!valid.has(details.authTokenHash)) {
        this.remove(ws);
        ws.close(REVOKED_CODE, 'session revoked');
      }
  }
  /** Cheap per-message recheck: at most one sweep query per interval. */
  async sweepIfStale(maxAgeMs = 2000): Promise<void> {
    if (Date.now() - this.lastSweep >= maxAgeMs) await this.sweep();
  }
}
