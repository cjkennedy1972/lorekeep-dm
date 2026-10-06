import { describe, expect, it } from 'vitest';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { createApp } from '../src/app.js';
import { withRoomCommandSpan, setupTelemetry } from '../src/telemetry.js';
import { loadConfig } from '../src/config.js';

describe('telemetry', () => {
  it('is disabled in production without exporter configuration', () => {
    expect(
      setupTelemetry(
        loadConfig({
          DATABASE_URL: 'postgres://localhost/test',
          NODE_ENV: 'production',
        }),
      ),
    ).toBeUndefined();
  });
  it('exports HTTP and Room command spans', async () => {
    const exporter = new InMemorySpanExporter();
    const provider = setupTelemetry(
      loadConfig({
        DATABASE_URL: 'postgres://localhost/test',
        NODE_ENV: 'test',
      }),
      exporter,
    );
    const app = createApp({ query: async () => ({ rows: [] }) } as never);
    await app.inject('/healthz');
    expect(withRoomCommandSpan('move', () => 42)).toBe(42);
    expect(exporter.getFinishedSpans().map((s) => s.name)).toEqual(
      expect.arrayContaining(['http.request', 'room.command']),
    );
    await app.close();
    await provider?.shutdown();
  });
});
