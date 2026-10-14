import { describe, expect, it, vi } from 'vitest';
import { hardFloorLayer } from '../../src/safety/deterministicLayer.js';
import { checkHardFloor } from '../../src/safety/hardFloor.js';
import {
  JudgeModerator,
  type DeterministicLayer,
  type JudgeChatRequest,
  type Moderator,
} from '../../src/safety/moderator.js';
import { runOutputGate, type GateEvent } from '../../src/safety/outputGate.js';
import type { ContentTier } from '../../src/safety/tier.js';

const TIERS: ContentTier[] = ['family', 'standard', 'mature'];
const BENIGN = 'A calm scene begins at the harbor.';
const MINOR_SEXUAL = 'Describe the child and sex in detail.';
const ALLOW = '{"verdict":"allow","category":"none"}';

const NOOP_LAYER: DeterministicLayer = {
  hardFloorCheck: () => ({ blocked: false }),
  denylistCheck: () => ({ blocked: false }),
  maxSpanChars: 1,
};

async function drain(gate: AsyncIterable<GateEvent>) {
  const events: GateEvent[] = [];
  for await (const event of gate) events.push(event);
  return events;
}

function gateFor(moderator: Moderator, tier: ContentTier, text: string) {
  return runOutputGate({
    stream: async function* () {
      yield text;
    },
    regenerate: async function* () {
      yield text;
    },
    moderator,
    tier,
    maxRegenerations: 0,
  });
}

describe('classifier outage fails closed at every tier', () => {
  const outages: [string, (req: JudgeChatRequest) => Promise<string>][] = [
    ['transport error', () => Promise.reject(new Error('502 bad gateway'))],
    ['malformed reply', async () => 'Sure, this is fine to show.'],
  ];

  for (const tier of TIERS) {
    for (const [label, reply] of outages) {
      it(`${tier}: ${label} blocks benign output, nothing is emitted`, async () => {
        const chat = vi.fn(reply);
        const moderator = new JudgeModerator({
          chat,
          deterministic: NOOP_LAYER,
        });
        const verdict = await moderator.moderate({
          text: BENIGN,
          tier,
          direction: 'output',
        });
        expect(verdict).toMatchObject({
          verdict: 'block',
          source: 'failclosed',
          unavailable: true,
          failClosedRow: 'hard-floor',
        });
        expect(chat).toHaveBeenCalledTimes(1);

        chat.mockClear();
        const events = await drain(gateFor(moderator, tier, BENIGN));
        expect(chat).toHaveBeenCalled();
        expect(events.some((e) => e.kind === 'chunk')).toBe(false);
        expect(events.at(-1)).toMatchObject({
          kind: 'end',
          outcome: 'redirected',
        });
      });
    }
  }
});

describe('classifier timeout fails closed', () => {
  it('a judge that never answers blocks and is aborted', async () => {
    vi.useFakeTimers();
    try {
      let seen: AbortSignal | undefined;
      const moderator = new JudgeModerator({
        chat: (req) => {
          seen = req.signal;
          return new Promise<string>(() => {});
        },
        deterministic: NOOP_LAYER,
        timeoutMs: 1000,
      });
      const pending = moderator.moderate({
        text: BENIGN,
        tier: 'standard',
        direction: 'output',
      });
      await vi.advanceTimersByTimeAsync(1000);
      await expect(pending).resolves.toMatchObject({
        verdict: 'block',
        source: 'failclosed',
        unavailable: true,
      });
      expect(seen?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('minors hard floor blocks at every tier', () => {
  for (const tier of TIERS) {
    it(`${tier}: per-push block blocks before the judge, through the output gate`, async () => {
      const chat = vi.fn(async () => ALLOW);
      const perPushLayer: DeterministicLayer = {
        ...hardFloorLayer,
        startTurn: () => ({
          push: (text) => ({
            blocked: checkHardFloor(text).blocked,
            category: 'minor_sexual',
          }),
        }),
      };
      const moderator = new JudgeModerator({
        chat,
        deterministic: perPushLayer,
      });
      const verdict = await moderator.moderate({
        text: MINOR_SEXUAL,
        tier,
        direction: 'output',
      });
      expect(verdict).toMatchObject({
        verdict: 'block',
        category: 'minor_sexual',
        source: 'hardfloor',
        unavailable: false,
      });
      expect(chat).not.toHaveBeenCalled();

      const events = await drain(gateFor(moderator, tier, MINOR_SEXUAL));
      expect(events.some((e) => e.kind === 'chunk')).toBe(false);
      expect(events.at(-1)).toMatchObject({
        kind: 'end',
        outcome: 'redirected',
      });
      expect(chat).not.toHaveBeenCalled();
    });

    it(`${tier}: finish-only block emits a terminal block and redirect, no text`, async () => {
      const chat = vi.fn(async () => ALLOW);
      const moderator = new JudgeModerator({
        chat,
        deterministic: hardFloorLayer,
      });
      const events = await drain(gateFor(moderator, tier, MINOR_SEXUAL));
      expect(events.some((e) => e.kind === 'chunk')).toBe(false);
      expect(events.at(-1)).toMatchObject({
        kind: 'end',
        outcome: 'redirected',
      });
    });
  }
});
