import { describe, expect, it } from 'vitest';
import { ChatPolicy } from '../../src/chat/policy.js';

describe('chat rate and flood policy', () => {
  it('allows five immediate messages, refills one token every two seconds, and caps sustained sends', () => {
    const policy = new ChatPolicy();
    for (let i = 0; i < 5; i++)
      expect(policy.reserve('room', 'seat', `m${i}`, 0)).toBe('allow');
    expect(policy.reserve('room', 'seat', 'm5', 0)).toBe('burst');
    expect(policy.reserve('room', 'seat', 'm6', 2_000)).toBe('allow');
    const sustained = new ChatPolicy();
    for (let i = 0; i < 40; i++)
      expect(sustained.reserve('room', 'seat', `s${i}`, i * 15_000)).toBe(
        'allow',
      );
    expect(sustained.reserve('room', 'seat', 's40', 599_999)).toBe('sustained');
  });

  it('drops duplicate normalized text before judging while consuming the burst token', () => {
    const policy = new ChatPolicy();
    expect(policy.reserve('room', 'seat', 'É', 1_000)).toBe('allow');
    expect(policy.reserve('room', 'seat', 'É', 2_000)).toBe('duplicate');
    expect(policy.reserve('room', 'seat', 'É', 62_000)).toBe('allow');
  });

  it('counts only attributable non-allows toward the three-in-five-minute chat mute', () => {
    const policy = new ChatPolicy();
    policy.recordNonAllow('room', 'seat', 0, true);
    policy.recordNonAllow('room', 'seat', 1_000, false);
    policy.recordNonAllow('room', 'seat', 2_000, true);
    expect(policy.isMuted('room', 'seat', 2_000)).toBe(false);
    policy.recordNonAllow('room', 'seat', 3_000, true);
    expect(policy.isMuted('room', 'seat', 3_000)).toBe(true);
    expect(policy.isMuted('room', 'seat', 303_000)).toBe(false);
  });

  it('enforces the per-table chat-gate cap independently of per-seat buckets', () => {
    const policy = new ChatPolicy();
    for (let i = 0; i < 120; i++)
      expect(policy.reserveTableGate('room', i)).toBe(true);
    expect(policy.reserveTableGate('room', 120)).toBe(false);
    expect(policy.reserveTableGate('room', 60_001)).toBe(true);
  });

  it('evicts seat and table-gate entries idle for one hour', () => {
    const policy = new ChatPolicy();
    policy.recordNonAllow('old-room', 'old-seat', 0);
    policy.reserveTableGate('old-room', 0);
    expect(policy.sweep(3_600_001)).toBe(2);
    expect(policy.sweep(3_600_002)).toBe(0);
    expect(policy.reserveTableGate('old-room', 3_600_002)).toBe(true);
    expect(policy.isMuted('old-room', 'old-seat', 3_600_002)).toBe(false);
  });
});
