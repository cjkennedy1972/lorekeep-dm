import { trace, type Span, type SpanOptions } from '@opentelemetry/api';
import {
  ConsoleSpanExporter,
  SimpleSpanProcessor,
  type SpanExporter,
} from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import type { ServerConfig } from './config.js';
export function startSpan(name: string, options?: SpanOptions): Span {
  return trace.getTracer('lorekeep-server').startSpan(name, options);
}
export function withRoomCommandSpan<T>(command: string, run: () => T): T {
  const span = startSpan('room.command', {
    attributes: { 'room.command': command },
  });
  try {
    return run();
  } catch (error) {
    span.recordException(error as Error);
    throw error;
  } finally {
    span.end();
  }
}
export function setupTelemetry(
  config: ServerConfig,
  testExporter?: SpanExporter,
): NodeTracerProvider | undefined {
  const exporter =
    testExporter ??
    (config.OTEL_EXPORTER_OTLP_ENDPOINT
      ? new OTLPTraceExporter({ url: config.OTEL_EXPORTER_OTLP_ENDPOINT })
      : config.NODE_ENV === 'development'
        ? new ConsoleSpanExporter()
        : undefined);
  if (!exporter) return undefined;
  const provider = new NodeTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  provider.register();
  return provider;
}
