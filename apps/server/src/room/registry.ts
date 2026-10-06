import type { Persistence } from '../persistence/index.js';
import { Room } from './Room.js';
import type { Lease, SessionLease } from './lease.js';

export class RoomRegistry {
  private readonly rooms = new Map<string, Room>();
  private readonly pending = new Map<string, Promise<Room>>();
  private readonly timers = new Map<string, ReturnType<typeof setInterval>>();
  constructor(
    private readonly store: Persistence,
    private readonly leases: SessionLease,
    private readonly nodeId: string,
  ) {}
  async get(sessionId: string): Promise<Room> {
    const existing = this.rooms.get(sessionId);
    if (existing) return existing;
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
    }, this.leases.heartbeatIntervalMs);
    timer.unref();
    this.timers.set(sessionId, timer);
  }
  async drain(): Promise<void> {
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
