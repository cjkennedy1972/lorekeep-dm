import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '../api';

const slots = ['fast', 'frontier', 'moderate'] as const;
type Slot = (typeof slots)[number];
type Capability = { supported: boolean; detail?: string };
type Probe = {
  capabilities: Record<string, Capability>;
  qualified: false;
  probedAt: string;
};
type Endpoint = {
  slot: Slot;
  baseUrl: string;
  model: string;
  apiStyle: 'openai' | 'anthropic';
  contextWindow?: number;
  unsupportedToolSchemaKeywords: string[];
  keySet: boolean;
  probe: Probe | null;
};
type Usage = {
  sessionId: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  latencyMs: number;
  retries: number;
  estimatedCalls: number;
  errorCalls: number;
};
const capabilityLabels: Record<string, string> = {
  reachability: 'Reachability',
  streaming: 'Streaming',
  nativeTools: 'Native tool calling',
  jsonSchema: 'JSON-schema responses',
  contextWindow32k: '32k context window',
};
function capabilityText(value: Capability) {
  return `${value.supported ? 'Pass' : 'Fail'}${value.detail ? ` — ${value.detail}` : ''}`;
}
function EndpointForm({
  slot,
  initial,
  onSaved,
}: {
  slot: Slot;
  initial?: Endpoint;
  onSaved: () => void;
}) {
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? '');
  const [model, setModel] = useState(initial?.model ?? '');
  const [apiStyle, setApiStyle] = useState<'openai' | 'anthropic'>(
    initial?.apiStyle ?? 'openai',
  );
  const [apiKey, setApiKey] = useState('');
  const [contextWindow, setContextWindow] = useState(
    initial?.contextWindow?.toString() ?? '',
  );
  const [keywords, setKeywords] = useState(
    initial?.unsupportedToolSchemaKeywords.join(', ') ?? '',
  );
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setBaseUrl(initial?.baseUrl ?? '');
    setModel(initial?.model ?? '');
    setApiStyle(initial?.apiStyle ?? 'openai');
    setContextWindow(initial?.contextWindow?.toString() ?? '');
    setKeywords(initial?.unsupportedToolSchemaKeywords.join(', ') ?? '');
    setApiKey('');
  }, [initial]);
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage('');
    const body: Record<string, unknown> = {
      baseUrl,
      model,
      apiStyle,
      unsupportedToolSchemaKeywords: keywords
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    };
    if (apiKey) body.apiKey = apiKey;
    if (contextWindow) body.contextWindow = Number(contextWindow);
    const result = await api<{ endpoint: Endpoint }>(
      `/api/operator/endpoints/${slot}`,
      body,
      'PUT',
    );
    setBusy(false);
    if (!result.ok)
      return setMessage(
        result.status === 404 ? 'Not authorized.' : result.message,
      );
    setApiKey('');
    setMessage('Endpoint saved. API key cleared from this form.');
    onSaved();
  }
  async function test() {
    setBusy(true);
    setMessage('Testing endpoint…');
    const result = await api<{ probe: Probe }>(
      `/api/operator/endpoints/${slot}/test`,
      {},
      'POST',
    );
    setBusy(false);
    if (!result.ok)
      return setMessage(
        result.status === 404 ? 'Not authorized.' : 'Connection test failed.',
      );
    setMessage('Connection test complete. See capability results below.');
    onSaved();
  }
  return (
    <section aria-labelledby={`endpoint-${slot}`}>
      <h3 id={`endpoint-${slot}`}>
        {slot[0]!.toUpperCase() + slot.slice(1)} endpoint
      </h3>
      <form className="form" onSubmit={(event) => void save(event)}>
        <div className="field">
          <label htmlFor={`${slot}-url`}>Base URL</label>
          <input
            id={`${slot}-url`}
            type="url"
            required
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor={`${slot}-model`}>Model name</label>
          <input
            id={`${slot}-model`}
            required
            value={model}
            onChange={(event) => setModel(event.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor={`${slot}-style`}>API style</label>
          <select
            id={`${slot}-style`}
            value={apiStyle}
            onChange={(event) =>
              setApiStyle(event.target.value as 'openai' | 'anthropic')
            }
          >
            <option value="openai">OpenAI-compatible</option>
            <option value="anthropic">Anthropic</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor={`${slot}-key`}>API key (write-only)</label>
          <input
            id={`${slot}-key`}
            type="password"
            autoComplete="new-password"
            placeholder={
              initial?.keySet ? 'Saved key retained if left blank' : 'Optional'
            }
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
          />
          <p className="field-hint">
            A saved key is never returned by the server. Leave blank to retain
            the existing key.
          </p>
        </div>
        <div className="field">
          <label htmlFor={`${slot}-context`}>
            Context window (tokens, optional)
          </label>
          <input
            id={`${slot}-context`}
            type="number"
            min="1"
            value={contextWindow}
            onChange={(event) => setContextWindow(event.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor={`${slot}-keywords`}>
            Unsupported tool schema keywords (comma-separated)
          </label>
          <input
            id={`${slot}-keywords`}
            value={keywords}
            onChange={(event) => setKeywords(event.target.value)}
          />
        </div>
        <div className="actions">
          <button type="submit" disabled={busy}>
            Save endpoint
          </button>
          <button
            className="secondary"
            type="button"
            disabled={busy || !initial}
            onClick={() => void test()}
          >
            Test connection
          </button>
        </div>
        <p role="status" aria-live="polite">
          {message}
        </p>
      </form>
      {initial?.probe && (
        <div>
          <p>
            <strong>Not qualified</strong> — connection probing does not replace
            the evaluation suite.
          </p>
          <p>
            Last tested:{' '}
            <time dateTime={initial.probe.probedAt}>
              {new Date(initial.probe.probedAt).toLocaleString()}
            </time>
          </p>
          <ul>
            {Object.entries(initial.probe.capabilities).map(
              ([name, result]) => (
                <li key={name}>
                  <strong>{capabilityLabels[name] ?? name}:</strong>{' '}
                  {capabilityText(result)}
                </li>
              ),
            )}
          </ul>
        </div>
      )}
    </section>
  );
}
export function OperatorSettings() {
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [usage, setUsage] = useState<Usage[]>([]);
  const [error, setError] = useState('');
  const refresh = useCallback(async () => {
    const [endpointResult, usageResult] = await Promise.all([
      api<{ endpoints: Endpoint[] }>('/api/operator/endpoints'),
      api<{ usage: Usage[] }>('/api/operator/usage'),
    ]);
    if (!endpointResult.ok || !usageResult.ok) {
      setError(
        endpointResult.status === 404 || usageResult.status === 404
          ? 'Not authorized.'
          : 'Could not load operator settings.',
      );
      return;
    }
    setError('');
    setEndpoints(endpointResult.data.endpoints);
    setUsage(usageResult.data.usage);
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const total = usage.reduce(
    (sum, row) => ({
      calls: sum.calls + row.calls,
      inputTokens: sum.inputTokens + row.inputTokens,
      outputTokens: sum.outputTokens + row.outputTokens,
      cachedTokens: sum.cachedTokens + row.cachedTokens,
      cacheWriteTokens: sum.cacheWriteTokens + row.cacheWriteTokens,
      latencyMs: sum.latencyMs + row.latencyMs,
      retries: sum.retries + row.retries,
      estimatedCalls: sum.estimatedCalls + row.estimatedCalls,
      errorCalls: sum.errorCalls + row.errorCalls,
    }),
    {
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      cacheWriteTokens: 0,
      latencyMs: 0,
      retries: 0,
      estimatedCalls: 0,
      errorCalls: 0,
    },
  );
  return (
    <>
      <h1>Operator settings</h1>
      {error && <p role="alert">{error}</p>}
      <section aria-labelledby="operator-endpoints">
        <h2 id="operator-endpoints">Model endpoints</h2>
        {slots.map((slot) => (
          <EndpointForm
            key={slot}
            slot={slot}
            initial={endpoints.find((endpoint) => endpoint.slot === slot)}
            onSaved={() => void refresh()}
          />
        ))}
      </section>
      <section aria-labelledby="operator-usage">
        <h2 id="operator-usage">Usage by table</h2>
        <p>
          All-time aggregate: {total.calls} calls; {total.inputTokens} input and{' '}
          {total.outputTokens} output tokens; {total.cachedTokens} cached,{' '}
          {total.cacheWriteTokens} cache-write; {total.estimatedCalls}{' '}
          estimated; {total.errorCalls} errors; {total.retries} retries;{' '}
          {total.latencyMs} ms total latency.
        </p>
        <div style={{ overflowX: 'auto' }}>
          <table>
            <caption>Metered endpoint usage per table</caption>
            <thead>
              <tr>
                <th scope="col">Table ID</th>
                <th scope="col">Calls</th>
                <th scope="col">Input tokens</th>
                <th scope="col">Output tokens</th>
                <th scope="col">Cached tokens</th>
                <th scope="col">Cache-write tokens</th>
                <th scope="col">Estimated calls</th>
                <th scope="col">Errors</th>
                <th scope="col">Retries</th>
                <th scope="col">Latency (ms)</th>
              </tr>
            </thead>
            <tbody>
              {usage.map((row) => (
                <tr key={row.sessionId}>
                  <th scope="row">{row.sessionId}</th>
                  <td>{row.calls}</td>
                  <td>{row.inputTokens}</td>
                  <td>{row.outputTokens}</td>
                  <td>{row.cachedTokens}</td>
                  <td>{row.cacheWriteTokens}</td>
                  <td>{row.estimatedCalls}</td>
                  <td>{row.errorCalls}</td>
                  <td>{row.retries}</td>
                  <td>{row.latencyMs}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
