import { describe, expect, it } from 'vitest';
import { hasMatureEndpointTechnicalSupport } from './matureEndpoint.js';

const probe = (over: Record<string, unknown> = {}) => ({
  id: 'fast',
  model: 'm',
  toolMode: 'native',
  validCallRate: 1,
  qualified: false,
  capabilities: {
    reachability: { supported: true },
    streaming: { supported: true },
    nativeTools: { supported: true },
    jsonSchema: { supported: false },
  },
  ...over,
});

describe('mature endpoint technical probe gate', () => {
  it('accepts complete technical support without requiring eval qualification or policy permission', () => {
    expect(hasMatureEndpointTechnicalSupport(probe(), 'fast', 'm')).toBe(true);
    expect(
      hasMatureEndpointTechnicalSupport(
        probe({ qualified: false, policyAllowsMature: false }),
        'fast',
        'm',
      ),
    ).toBe(true);
  });

  it('accepts either selected mode when its own capability passed, even if aggregate rate is lower', () => {
    expect(
      hasMatureEndpointTechnicalSupport(
        probe({ validCallRate: 0.5 }),
        'fast',
        'm',
      ),
    ).toBe(true);
    const jsonSchema = probe({
      toolMode: 'json-schema',
      capabilities: {
        reachability: { supported: true },
        streaming: { supported: true },
        nativeTools: { supported: false },
        jsonSchema: { supported: true },
      },
    });
    expect(hasMatureEndpointTechnicalSupport(jsonSchema, 'fast', 'm')).toBe(
      true,
    );
  });

  it('does not require structured tool support for the text-only moderation endpoint', () => {
    const moderationProbe = probe({
      id: 'moderate',
      toolMode: 'unsupported',
      capabilities: {
        reachability: { supported: true },
        streaming: { supported: true },
        nativeTools: { supported: false },
        jsonSchema: { supported: false },
      },
    });
    expect(
      hasMatureEndpointTechnicalSupport(
        moderationProbe,
        'moderate',
        'm',
        'moderation',
      ),
    ).toBe(true);
    expect(
      hasMatureEndpointTechnicalSupport(moderationProbe, 'moderate', 'm'),
    ).toBe(false);
  });

  it('still requires reachability and streaming for moderation', () => {
    const moderationProbe = probe({
      id: 'moderate',
      toolMode: 'unsupported',
      capabilities: {
        reachability: { supported: true },
        streaming: { supported: false },
        nativeTools: { supported: false },
      },
    });
    expect(
      hasMatureEndpointTechnicalSupport(
        moderationProbe,
        'moderate',
        'm',
        'moderation',
      ),
    ).toBe(false);
  });

  it.each([
    ['missing probe', null],
    [
      'unreachable endpoint',
      probe({
        capabilities: {
          reachability: { supported: false },
          streaming: { supported: true },
          nativeTools: { supported: true },
        },
      }),
    ],
    [
      'non-streaming endpoint',
      probe({
        capabilities: {
          reachability: { supported: true },
          streaming: { supported: false },
          nativeTools: { supported: true },
        },
      }),
    ],
    ['unsupported tool mode', probe({ toolMode: 'unsupported' })],
    [
      'tool-mode capability absent',
      probe({
        capabilities: {
          reachability: { supported: true },
          streaming: { supported: true },
          nativeTools: { supported: false },
        },
      }),
    ],
    ['wrong endpoint slot', probe({ id: 'moderate' })],
    ['wrong model', probe({ model: 'other' })],
  ])('rejects %s', (_label, facts) => {
    expect(
      hasMatureEndpointTechnicalSupport(
        facts as ReturnType<typeof probe> | null,
        'fast',
        'm',
      ),
    ).toBe(false);
  });
});
