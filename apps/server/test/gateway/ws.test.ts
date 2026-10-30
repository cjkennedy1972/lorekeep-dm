import { describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import {
  ClientEnvelopeSchema,
  KickSeatSchema,
  TransferHostSchema,
  ApproveLateJoinSchema,
  DenyLateJoinSchema,
  EndTableSchema,
  ConfigureRoundTimerSchema,
} from '@game/schema';
import {
  consumeMessageToken,
  createGatewayMessageAdmission,
  queueSyncRequest,
} from '../../src/gateway/ws.js';
import { ConnectionRegistry } from '../../src/gateway/connections.js';
describe('gateway envelope', () => {
  it('accepts the Prism host-control command names and rejects out-of-range timers', () => {
    const base = { actionId: crypto.randomUUID(), lastSeq: 0 };
    const seatId = crypto.randomUUID();
    const requestId = crypto.randomUUID();
    expect(
      KickSeatSchema.safeParse({
        ...base,
        type: 'KickSeat',
        payload: { seatId },
      }).success,
    ).toBe(true);
    expect(
      TransferHostSchema.safeParse({
        ...base,
        type: 'TransferHost',
        payload: { seatId },
      }).success,
    ).toBe(true);
    expect(
      ApproveLateJoinSchema.safeParse({
        ...base,
        type: 'ApproveLateJoin',
        payload: { requestId },
      }).success,
    ).toBe(true);
    expect(
      DenyLateJoinSchema.safeParse({
        ...base,
        type: 'DenyLateJoin',
        payload: { requestId },
      }).success,
    ).toBe(true);
    expect(
      EndTableSchema.safeParse({ ...base, type: 'EndTable', payload: {} })
        .success,
    ).toBe(true);
    for (const durationMs of [null, 30_000, 600_000])
      expect(
        ConfigureRoundTimerSchema.safeParse({
          ...base,
          type: 'ConfigureRoundTimer',
          payload: { durationMs },
        }).success,
      ).toBe(true);
    for (const durationMs of [0, 29_999, 600_001])
      expect(
        ConfigureRoundTimerSchema.safeParse({
          ...base,
          type: 'ConfigureRoundTimer',
          payload: { durationMs },
        }).success,
      ).toBe(false);
  });
  it('enforces a refillable per-socket token bucket', () => {
    const bucket = { tokens: 20, updatedAt: 1000 };
    for (let index = 0; index < 20; index++)
      expect(consumeMessageToken(bucket, 1000)).toBe(true);
    expect(consumeMessageToken(bucket, 1000)).toBe(false);
    expect(consumeMessageToken(bucket, 1100)).toBe(true);
    expect(consumeMessageToken(bucket, 1100)).toBe(false);
  });

  it('allows a bounded sync burst without enlarging the action flood budget', () => {
    const syncBucket = { tokens: 40, updatedAt: 1000 };
    const actionBucket = { tokens: 20, updatedAt: 1000 };
    for (let index = 0; index < 40; index++)
      expect(consumeMessageToken(syncBucket, 1000, 40)).toBe(true);
    expect(consumeMessageToken(syncBucket, 1000, 40)).toBe(false);
    for (let index = 0; index < 20; index++)
      expect(consumeMessageToken(actionBucket, 1000)).toBe(true);
    expect(consumeMessageToken(actionBucket, 1000)).toBe(false);
  });

  it('dispatch admission preserves action tokens and bounds concurrent sync reads', () => {
    const admission = createGatewayMessageAdmission();
    for (let index = 0; index < 40; index++) {
      expect(admission.admit('Resync', 1000)).toBe(true);
      admission.complete('Resync');
    }
    expect(admission.admit('Resync', 1000)).toBe(false);
    expect(admission.admit('Resync', 1100)).toBe(false);
    expect(admission.admit('Resync', 1500)).toBe(true);
    admission.complete('Resync');
    for (let index = 0; index < 20; index++)
      expect(admission.admit('PlayerAction', 1500)).toBe(true);
    expect(admission.admit('PlayerAction', 1500)).toBe(false);

    const concurrent = createGatewayMessageAdmission();
    expect(concurrent.admit('Resync', 1000)).toBe(true);
    expect(concurrent.admit('Resync', 1000)).toBe(false);
    expect(concurrent.admit('ChatHistoryRequest', 1000)).toBe(true);
    expect(concurrent.admit('ChatHistoryRequest', 1000)).toBe(false);
    concurrent.complete('Resync');
    expect(concurrent.admit('Resync', 1000)).toBe(true);
  });

  it('expires a sync request admitted behind a hung dispatch and releases its slot', async () => {
    vi.useFakeTimers();
    try {
      const admission = createGatewayMessageAdmission();
      const close = vi.fn();
      let releasePriorStep!: () => void;
      const priorStep = new Promise<void>((resolve) => {
        releasePriorStep = resolve;
      });
      const dispatch = vi.fn();
      const release = vi.fn(() => admission.complete('ChatHistoryRequest'));
      expect(admission.admit('ChatHistoryRequest', 1000)).toBe(true);
      const queuedChain = queueSyncRequest(
        priorStep,
        dispatch,
        () => close(1011, 'Sync request deadline exceeded'),
        release,
        10,
      ).catch(() => undefined);
      await vi.advanceTimersByTimeAsync(10);
      await queuedChain;
      expect(close).toHaveBeenCalledWith(
        1011,
        'Sync request deadline exceeded',
      );
      expect(admission.admit('ChatHistoryRequest', 1000)).toBe(true);
      expect(release).toHaveBeenCalledOnce();
      releasePriorStep();
      await Promise.resolve();
      expect(dispatch).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not revoke a socket added while the session query is in flight', async () => {
    let resolveQuery!: (result: { rows: { token_hash: string }[] }) => void;
    const query = vi.fn(
      () =>
        new Promise<{ rows: { token_hash: string }[] }>((resolve) => {
          resolveQuery = resolve;
        }),
    );
    const registry = new ConnectionRegistry({ query } as never);
    const existing = { readyState: 1, close: vi.fn() } as unknown as WebSocket;
    expect(registry.reserveSeat('session:existing', existing).reserved).toBe(
      true,
    );
    registry.add(existing, 'existing-hash', 'session:existing');

    const sweeping = registry.sweep();
    const connecting = {
      readyState: 1,
      close: vi.fn(),
    } as unknown as WebSocket;
    expect(
      registry.reserveSeat('session:connecting', connecting).reserved,
    ).toBe(true);
    registry.add(connecting, 'new-hash', 'session:connecting');
    resolveQuery({ rows: [{ token_hash: 'existing-hash' }] });
    await sweeping;

    expect(connecting.close).not.toHaveBeenCalled();
    expect(registry.size).toBe(2);
  });

  it('revokes a snapshotted socket whose session is invalid', async () => {
    const registry = new ConnectionRegistry({
      query: async () => ({ rows: [] }),
    } as never);
    const socket = { readyState: 1, close: vi.fn() } as unknown as WebSocket;
    expect(registry.reserveSeat('session:revoked', socket).reserved).toBe(true);
    registry.add(socket, 'revoked-hash', 'session:revoked');

    await registry.sweep();

    expect(socket.close).toHaveBeenCalledOnce();
    expect(socket.close).toHaveBeenCalledWith(4401, 'session revoked');
    expect(registry.size).toBe(0);
  });

  it('replaces an in-memory socket only after the caller validates the seat token', () => {
    const registry = new ConnectionRegistry({
      query: async () => ({ rows: [] }),
    } as never);
    const oldSocket = {
      readyState: 1,
      close: vi.fn(),
    } as unknown as WebSocket;
    const newSocket = {
      readyState: 1,
      close: vi.fn(),
    } as unknown as WebSocket;
    expect(registry.reserveSeat('session:seat', oldSocket)).toEqual({
      reserved: true,
      takenOver: false,
    });
    registry.add(oldSocket, 'auth-hash', 'session:seat');
    expect(registry.reserveSeat('session:seat', newSocket)).toEqual({
      reserved: false,
      takenOver: false,
    });
    expect(oldSocket.close).not.toHaveBeenCalled();
    expect(registry.reserveSeat('session:seat', newSocket, true)).toEqual({
      reserved: true,
      takenOver: true,
    });
    expect(oldSocket.close).toHaveBeenCalledOnce();
    expect(registry.hasSeatSocket('session:seat')).toBe(false);
  });
  it('limits socket authentication attempts per seat, account, and IP', () => {
    const registry = new ConnectionRegistry({
      query: async () => ({ rows: [] }),
    } as never);
    for (let i = 0; i < 5; i++)
      expect(registry.consumeSeatAuthAttempt('session:seat', 10_000 + i)).toBe(
        true,
      );
    expect(registry.consumeSeatAuthAttempt('session:seat', 10_100)).toBe(false);
    expect(registry.consumeSeatAuthAttempt('session:seat', 70_001)).toBe(true);

    for (let i = 0; i < 30; i++)
      expect(
        registry.consumeTransportAuthAttempt(
          `account-${i}`,
          'shared-ip',
          100_000 + i,
        ),
      ).toBe(true);
    for (let i = 0; i < 90; i++)
      expect(
        registry.consumeTransportAuthAttempt(
          `other-${i}`,
          'shared-ip',
          100_200 + i,
        ),
      ).toBe(true);
    expect(
      registry.consumeTransportAuthAttempt(
        'last-account',
        'shared-ip',
        100_400,
      ),
    ).toBe(false);
  });
  it('bounds IP auth history and evicts expired IP keys', () => {
    const registry = new ConnectionRegistry({
      query: async () => ({ rows: [] }),
    } as never);
    for (let i = 0; i < 10_050; i++)
      registry.consumeTransportAuthAttempt(`account-${i}`, `ip-${i}`, 10_000);

    const ipAttempts = (
      registry as unknown as {
        ipAuthAttempts: Map<string, number[]>;
      }
    ).ipAuthAttempts;
    expect(ipAttempts.size).toBeLessThanOrEqual(10_000);
    expect(ipAttempts.has('ip-10049')).toBe(true);

    registry.consumeTransportAuthAttempt('fresh-account', 'fresh-ip', 70_001);
    expect(ipAttempts.size).toBe(1);
    expect(ipAttempts.has('fresh-ip')).toBe(true);
  });
  it('rejects malformed and accepts client wire format', () => {
    expect(ClientEnvelopeSchema.safeParse({ type: 'Resync' }).success).toBe(
      false,
    );
    expect(
      ClientEnvelopeSchema.safeParse({
        actionId: crypto.randomUUID(),
        type: 'Resync',
        payload: {},
        lastSeq: 0,
      }).success,
    ).toBe(true);
  });
});
