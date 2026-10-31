// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import type { ServerMessage } from '@game/schema';
import { NarrationLog } from './NarrationLog.js';
import { visibleChunks } from './logState.js';

test('a completed turn whose body is only whitespace shows the unavailable line, not an empty bubble', () => {
  const { container } = render(
    <NarrationLog
      messages={[
        {
          seq: 1,
          type: 'NarrationCompleted',
          payload: { turnId: 'turn-blank', text: ' \n\t  \n ' },
        } as ServerMessage,
      ]}
    />,
  );

  expect(screen.getByText('Narration unavailable.')).toBeInTheDocument();
  expect(container.querySelector('.narration-log__turn > p:empty')).toBeNull();
  expect(
    container.querySelector('.narration-log__turn')?.textContent?.trim(),
  ).toBe('Narration unavailable.');
});

test('a streaming turn whose chunks are only whitespace keeps waiting instead of rendering a blank body', () => {
  const { container } = render(
    <NarrationLog
      messages={[
        {
          seq: 1,
          type: 'NarrationChunk',
          payload: { turnId: 'turn-stream', index: 0, text: '   \n  ' },
        } as ServerMessage,
      ]}
    />,
  );

  expect(screen.getByText('Waiting for narration…')).toBeInTheDocument();
  expect(container.querySelector('.narration-log__turn > p:empty')).toBeNull();
});

test('visibleChunks treats a whitespace-only completed narration as no body', () => {
  expect(
    visibleChunks({
      turnId: 't',
      chunks: {},
      complete: true,
      narration: '  \n ',
      rollEvents: [],
    } as never),
  ).toBe('');
});
