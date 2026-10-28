// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test } from 'vitest';
import type { ServerMessage } from '@game/schema';
import { NarrationLog } from './NarrationLog.js';

// jsdom has no layout: give the story list a fixed geometry and a settable scrollTop.
const geometry = { scrollHeight: 1000, clientHeight: 200 };
const original = {
  scrollHeight: Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    'scrollHeight',
  ),
  clientHeight: Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    'clientHeight',
  ),
  scrollTop: Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    'scrollTop',
  ),
};

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get: () => geometry.scrollHeight,
  });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get: () => geometry.clientHeight,
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
    configurable: true,
    get(this: HTMLElement) {
      return Number(this.dataset.testScrollTop ?? 0);
    },
    set(this: HTMLElement, value: number) {
      this.dataset.testScrollTop = String(value);
    },
  });
});

afterEach(() => {
  for (const [key, descriptor] of Object.entries(original)) {
    if (descriptor)
      Object.defineProperty(HTMLElement.prototype, key, descriptor);
    else
      delete (HTMLElement.prototype as unknown as Record<string, unknown>)[key];
  }
});

const turn = (seq: number, turnId: string, text: string): ServerMessage =>
  ({
    seq,
    type: 'NarrationCompleted',
    payload: { turnId, text },
  }) as ServerMessage;

test('new narration follows the reader while they are at the bottom', () => {
  const { rerender } = render(
    <NarrationLog messages={[turn(1, 'turn-1', 'The gate creaks.')]} />,
  );
  const list = screen.getByRole('list', { name: /Story entries/ });
  expect(list.scrollTop).toBe(geometry.scrollHeight);

  rerender(
    <NarrationLog
      messages={[
        turn(1, 'turn-1', 'The gate creaks.'),
        turn(2, 'turn-2', 'Rain starts. What do you do?'),
      ]}
    />,
  );

  expect(list.scrollTop).toBe(geometry.scrollHeight);
  expect(
    screen.queryByRole('button', { name: 'New narration' }),
  ).not.toBeInTheDocument();
});

test('new narration while scrolled up shows a New narration chip instead of moving the reader', () => {
  const { rerender } = render(
    <NarrationLog messages={[turn(1, 'turn-1', 'The gate creaks.')]} />,
  );
  const list = screen.getByRole('list', { name: /Story entries/ });

  list.scrollTop = 0;
  fireEvent.scroll(list);

  rerender(
    <NarrationLog
      messages={[
        turn(1, 'turn-1', 'The gate creaks.'),
        turn(2, 'turn-2', 'Rain starts. What do you do?'),
      ]}
    />,
  );

  expect(list.scrollTop).toBe(0);
  const chip = screen.getByRole('button', { name: 'New narration' });
  expect(chip).toBeInTheDocument();

  fireEvent.click(chip);

  expect(list.scrollTop).toBe(geometry.scrollHeight);
  expect(
    screen.queryByRole('button', { name: 'New narration' }),
  ).not.toBeInTheDocument();
});

test('a scrolled-up reader with no new narration sees Jump to latest, outside the scrolling text', () => {
  render(<NarrationLog messages={[turn(1, 'turn-1', 'The gate creaks.')]} />);
  const list = screen.getByRole('list', { name: /Story entries/ });

  list.scrollTop = 0;
  fireEvent.scroll(list);

  const jump = screen.getByRole('button', { name: 'Jump to latest' });
  expect(list.contains(jump)).toBe(false);
});

const restored = (seq: number, turnId: string, text: string): ServerMessage =>
  ({
    seq,
    type: 'NarrationHistory',
    payload: { turns: [{ turnId, text, tier: 'standard' }] },
  }) as ServerMessage;

test('restored history renders through the narration renderer with the closing prompt on its own line', () => {
  const { container } = render(
    <NarrationLog
      messages={[
        restored(
          1,
          'old',
          'The **gate** opens onto a *salt* road.\n\nWho goes first?',
        ),
      ]}
      historyRestoreKey={1}
    />,
  );

  expect(container.querySelector('strong')?.textContent).toBe('gate');
  expect(container.querySelector('em')?.textContent).toBe('salt');
  expect(container.querySelector('.narration-log__prompt')?.textContent).toBe(
    'Who goes first?',
  );
});

test('restore lands at the bottom with no chip, even when the reader had scrolled up', () => {
  const { rerender } = render(
    <NarrationLog messages={[turn(1, 'turn-1', 'The gate creaks.')]} />,
  );
  const list = screen.getByRole('list', { name: /Story entries/ });
  list.scrollTop = 0;
  fireEvent.scroll(list);

  rerender(
    <NarrationLog
      messages={[
        turn(1, 'turn-1', 'The gate creaks.'),
        restored(2, 'old', 'An old scene.'),
      ]}
      historyRestoreKey={1}
    />,
  );

  expect(list.scrollTop).toBe(geometry.scrollHeight);
  expect(screen.queryByRole('button', { name: 'New narration' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Jump to latest' })).toBeNull();
});

test('a live narration after restore follows the bottom while the reader is there', () => {
  const { rerender } = render(
    <NarrationLog
      messages={[restored(1, 'old', 'An old scene.')]}
      historyRestoreKey={1}
    />,
  );
  const list = screen.getByRole('list', { name: /Story entries/ });

  rerender(
    <NarrationLog
      messages={[
        restored(1, 'old', 'An old scene.'),
        turn(2, 'live', 'Rain starts. What do you do?'),
      ]}
      historyRestoreKey={1}
    />,
  );

  expect(list.scrollTop).toBe(geometry.scrollHeight);
  expect(screen.queryByRole('button', { name: 'New narration' })).toBeNull();
});

test('a live narration after restore raises the New narration chip while the reader is scrolled up', () => {
  const { rerender } = render(
    <NarrationLog
      messages={[restored(1, 'old', 'An old scene.')]}
      historyRestoreKey={1}
    />,
  );
  const list = screen.getByRole('list', { name: /Story entries/ });

  list.scrollTop = 0;
  fireEvent.scroll(list);
  rerender(
    <NarrationLog
      messages={[
        restored(1, 'old', 'An old scene.'),
        turn(2, 'live', 'Rain starts. What do you do?'),
      ]}
      historyRestoreKey={1}
    />,
  );

  expect(list.scrollTop).toBe(0);
  expect(
    screen.getByRole('button', { name: 'New narration' }),
  ).toBeInTheDocument();
});
