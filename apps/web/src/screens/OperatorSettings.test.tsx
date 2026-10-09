// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { MemoryRouter } from 'react-router-dom';
import { Route, Routes } from 'react-router-dom';
import { expect, test } from 'vitest';
import { Layout } from '../a11y/Layout';
import { OperatorSettings } from './OperatorSettings';
import { http } from '../api';

const endpoint = {
  slot: 'fast',
  baseUrl: 'https://models.example.test/v1',
  model: 'fast-model',
  apiStyle: 'openai',
  contextWindow: 32768,
  unsupportedToolSchemaKeywords: [],
  keySet: true,
  probe: {
    qualified: false,
    probedAt: '2026-10-01T00:00:00.000Z',
    capabilities: {
      reachability: { supported: true },
      streaming: { supported: true },
      nativeTools: { supported: false, detail: 'valid-call rate below 0.95' },
      jsonSchema: { supported: true },
      contextWindow32k: { supported: true },
    },
  },
};
test('operator form never populates key, clears it after save, reports text capabilities and usage accessibly', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  http.fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith('/api/operator/endpoints'))
      return Response.json({ endpoints: [endpoint] });
    if (url.endsWith('/api/operator/usage'))
      return Response.json({
        usage: [
          {
            sessionId: 'table-1',
            calls: 2,
            inputTokens: 10,
            outputTokens: 4,
            cachedTokens: 1,
            cacheWriteTokens: 0,
            latencyMs: 20,
            retries: 1,
            estimatedCalls: 0,
            errorCalls: 0,
          },
        ],
      });
    if (url.endsWith('/api/operator/endpoints/fast') && init?.method === 'PUT')
      return Response.json({ endpoint });
    return Response.json({});
  };
  render(
    <MemoryRouter initialEntries={['/operator']}>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/operator" element={<OperatorSettings />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
  expect(await screen.findByText('Not qualified')).toBeInTheDocument();
  expect(screen.getByText('Reachability:').parentElement).toHaveTextContent(
    'Pass',
  );
  expect(
    screen.getByText(/Native tool calling:/).parentElement,
  ).toHaveTextContent('Fail — valid-call rate below 0.95');
  expect(
    screen.getByRole('table', { name: 'Metered endpoint usage per table' }),
  ).toHaveTextContent('table-1');
  const key = screen.getByLabelText('API key (write-only)', {
    selector: '#fast-key',
  }) as HTMLInputElement;
  expect(key.value).toBe('');
  await userEvent.type(key, 'secret-never-read-back');
  await userEvent.click(
    screen.getAllByRole('button', { name: 'Save endpoint' })[0]!,
  );
  await waitFor(() => expect(key.value).toBe(''));
  const save = calls.find((call) => call.init?.method === 'PUT');
  expect(save?.init?.body).toContain('secret-never-read-back');
  expect(
    JSON.stringify(calls.filter((call) => call.init?.method !== 'PUT')),
  ).not.toContain('secret-never-read-back');
  expect((await axe(document.body)).violations).toEqual([]);
});
