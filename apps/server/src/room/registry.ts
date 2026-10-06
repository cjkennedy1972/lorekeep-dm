import type { Persistence } from '../persistence/index.js';
import { Room } from './Room.js';
import type { Lease, SessionLease } from './lease.js';

export class RoomRegistry {
  private readonly rooms = new Map<string, Room>();
  private readonly pending = new Map<string, Promise<Room>>();
  private readonly timers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly lastUsed = new Map<string, number>();
  private readonly evicting = new Map<string, Promise<void>>();
  private readonly idleTimer?: ReturnType<typeof setInterval>;
  /** Rooms with no sockets for `idleMs` are drained and their lease released; `get` rehydrates from persistence. */
  constructor(
    private readonly store: Persistence,
    private readonly leases: SessionLease,
    private readonly nodeId: string,
    private readonly idleMs = 10 * 60_000,
    sweepMs = 60_000,
  ) {
    this.idleTimer = setInterval(() => void this.evictIdle(), sweepMs);
    this.idleTimer.unref();
  }
  /** Evicts idle rooms; returns the evicted session ids. */
  async evictIdle(now = Date.now()): Promise<string[]> {
    const victims = [...this.rooms].filter(
      ([id, room]) =>
        room.connectionCount === 0 &&
        now - (this.lastUsed.get(id) ?? 0) >= this.idleMs,
    );
    await Promise.all(victims.map(([id, room]) => this.evict(id, room)));
    return victims.map(([id]) => id);
  }
  private evict(sessionId: string, room: Room): Promise<void> {
    // Remove from the map synchronously so no new caller gets a draining room.
    this.rooms.delete(sessionId);
    this.lastUsed.delete(sessionId);
    const timer = this.timers.get(sessionId);
    if (timer) clearInterval(timer);
    this.timers.delete(sessionId);
    const done = (async () => {
      await room.drain();
      await this.leases.release(room.lease);
    })()
      .catch(() => {})
      .finally(() => this.evicting.delete(sessionId));
    this.evicting.set(sessionId, done);
    return done;
  }
  async get(sessionId: string): Promise<Room> {
    await this.evicting.get(sessionId);
    const existing = this.rooms.get(sessionId);
    if (existing) {
      this.lastUsed.set(sessionId, Date.now());
      return existing;
    }
    const pending = this.pending.get(sessionId);
    if (pending) return pending;
    const startup = this.start(sessionId);
    this.pending.set(sessionId, startup);
    try {
      return await startup;
    } finally {
      this.pending.delete(sessionId);
    }
  }
  private async start(sessionId: string): Promise<Room> {
    const lease = await this.leases.acquire(sessionId, this.nodeId);
    if (!lease) throw new Error('Room lease unavailable');
    try {
      const room = new Room(
        this.store,
        lease,
        await this.store.loadLatest(sessionId),
      );
      this.rooms.set(sessionId, room);
      this.lastUsed.set(sessionId, Date.now());
      this.heartbeat(sessionId, room, lease);
      return room;
    } catch (error) {
      await this.leases.release(lease);
      throw error;
    }
  }
  private heartbeat(sessionId: string, room: Room, lease: Lease): void {
    const timer = setInterval(async () => {
      try {
        if (await this.leases.renew(lease)) return;
      } catch {
        /* treat renewal failure as lost lease */
      }
      clearInterval(timer);
      this.timers.delete(sessionId);
      await room.drain();
      this.rooms.delete(sessionId);
      this.lastUsed.delete(sessionId);
    }, this.leases.heartbeatIntervalMs);
    timer.unref();
    this.timers.set(sessionId, timer);
  }
  async drain(): Promise<void> {
    clearInterval(this.idleTimer);
    for (const timer of this.timers.values()) clearInterval(timer);
    this.timers.clear();
    await Promise.all(
      [...this.rooms.values()].map(async (room) => {
        await room.drain();
        await this.leases.release(room.lease);
      }),
    );
    this.rooms.clear();
  }
}
