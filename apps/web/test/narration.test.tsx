import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { axe } from 'jest-axe';
import { describe, expect, it, vi } from 'vitest';
import { ActionIdSchema, type ServerMessage } from '@game/schema';
import { NarrationLog } from '../src/features/narration/NarrationLog.js';
import { roomReducer, initialRoomView } from '../src/room/reducer.js';

const roll = {
  type: 'RollEvent' as const,
  turnId: 'turn-1',
  breakdown: {
    expression: '1d20',
    dice: [{ sides: 20, value: 15, kept: true }],
    modifiers: [{ label: 'Stealth', value: 2 }],
    total: 17,
  },
  dc: 15,
  dcReason: 'slick stone wall',
};

const messages: ServerMessage[] = [
  { seq: 1, type: 'ActionQueued', payload: { actionId: 'action-1' } },
  { seq: 2, type: 'TurnThinking', payload: { actionId: 'action-1' } },
  { seq: 3, type: 'RollEvent', payload: roll },
  {
    seq: 4,
    type: 'NarrationChunk',
    payload: { turnId: 'turn-1', index: 0, text: 'The door ' },
  },
  {
    seq: 5,
    type: 'NarrationChunk',
    payload: { turnId: 'turn-1', index: 1, text: 'opens.' },
  },
  {
    seq: 6,
    type: 'NarrationCompleted',
    payload: { turnId: 'turn-1', text: 'The door opens.', words: 3 },
  },
];

describe('NarrationLog', () => {
  it('renders and announces concentration saves and drops accessibly', async () => {
    const messages: ServerMessage[] = [
      {
        seq: 1,
        type: 'CombatEvents',
        payload: {
          events: [
            {
              type: 'RollEvent',
              entityId: 'ent_aria',
              kind: 'save',
              total: 14,
              dc: 10,
              success: true,
            },
            {
              type: 'ConcentrationDropped',
              entityId: 'ent_aria',
              spellId: 'srd:spell/bless',
            },
          ],
        },
      },
    ];
    const { container } = render(
      <NarrationLog
        messages={messages}
        combatantNames={{ ent_aria: 'Aria' }}
      />,
    );
    expect(
      await screen.findByText(
        'Aria: Constitution save 14 vs DC 10 - concentration kept',
      ),
    ).toBeInTheDocument();
    expect(screen.getAllByText('Aria: concentration lost')).toHaveLength(2);
    expect(
      container.querySelector('[role=status][aria-live=polite]'),
    ).toHaveTextContent('Aria: concentration lost');
    expect((await axe(container)).violations).toEqual([]);
  });

  it('uses the room reducer sequence and places rolls before streamed narration', async () => {
    let view = initialRoomView;
    for (const message of messages) view = roomReducer(view, message);
    expect(view.lastSeq).toBe(0);
    render(<NarrationLog messages={messages} />);
    await screen.findByText('The door opens.');
    const turn = screen.getByText('The door opens.').closest('li');
    expect(turn).toHaveTextContent('Roll result');
    expect(
      turn
        ?.querySelector('.narration-log__rolls')
        ?.compareDocumentPosition(screen.getByText('The door opens.')),
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(turn).toHaveTextContent('The door opens.');
    expect(screen.queryByText('The DM is thinking…')).not.toBeInTheDocument();
    const disclosure = screen.getByText('Why DC 15?');
    expect(screen.getByText('slick stone wall')).not.toBeVisible();
    disclosure.focus();
    fireEvent.click(disclosure);
    expect(disclosure.closest('details')).toHaveAttribute('open');
    expect(screen.getByText('slick stone wall')).toBeVisible();
  });

  it('renders fallback completion as a distinct accessible notice', async () => {
    render(
      <NarrationLog
        messages={[
          {
            seq: 1,
            type: 'NarrationCompleted',
            payload: {
              turnId: 'fallback-turn',
              text: 'A brief fallback scene.',
              words: 4,
              fallback: 'endpoint-error',
            },
          },
        ]}
      />,
    );
    const notice = await screen.findByText(/narration service was unavailable/);
    expect(notice).toHaveTextContent('narration service was unavailable');
    expect(screen.getByText('A brief fallback scene.')).toBeInTheDocument();
    expect(notice.closest('li')).toContainElement(
      screen.getByText('A brief fallback scene.'),
    );
  });

  it('announces a completed narration once, not each streamed chunk', async () => {
    const view = render(<NarrationLog messages={messages.slice(0, 5)} />);
    expect(screen.getByText(/The door/)).toBeInTheDocument();
    expect(screen.getAllByRole('status').at(-1)).toBeEmptyDOMElement();
    expect(screen.getAllByRole('status')[0]).toHaveTextContent(
      'The DM is thinking.',
    );
    view.rerender(<NarrationLog messages={messages} />);
    await waitFor(() =>
      expect(screen.getAllByRole('status').at(-1)).toHaveTextContent(
        'Narration: The door opens.',
      ),
    );
    expect(screen.getAllByRole('status').at(-1)).toHaveTextContent(
      'Narration: The door opens.',
    );
    expect(screen.getAllByRole('status').at(-1)).toHaveTextContent(
      'The door opens.',
    );
  });

  it('handles duplicate completion, completion without chunks, and errors after partial chunks', async () => {
    const complete = messages[5]!;
    const error: ServerMessage = {
      seq: 8,
      type: 'Error',
      payload: {
        code: 'TURN_FAILED',
        message: 'Try again.',
        actionId: ActionIdSchema.parse('00000000-0000-4000-8000-0000000000a2'),
      },
    };
    const retry = vi.fn();
    const sequence: ServerMessage[] = [
      {
        seq: 1,
        type: 'NarrationChunk',
        payload: { turnId: 'turn-partial', index: 0, text: 'Partial' },
      },
      {
        seq: 2,
        type: 'Error',
        payload: {
          code: 'TURN_FAILED',
          message: 'Try again.',
          actionId: ActionIdSchema.parse(
            '00000000-0000-4000-8000-0000000000a2',
          ),
        },
      },
      complete,
      { ...complete, seq: 7 },
      {
        seq: 9,
        type: 'NarrationCompleted',
        payload: {
          turnId: 'turn-no-chunks',
          text: 'No chunks here.',
          words: 3,
        },
      },
      error,
    ];
    render(<NarrationLog messages={sequence} onRetry={retry} />);
    await screen.findByText('No chunks here.');
    expect(screen.getByText('The door opens.')).toBeInTheDocument();
    expect(screen.getAllByText('TURN_FAILED:')).toHaveLength(2);
    fireEvent.click(
      screen.getAllByRole('button', { name: 'Retry this action' })[0]!,
    );
    expect(retry).toHaveBeenCalledWith('00000000-0000-4000-8000-0000000000a2');
  });

  it('passes axe in default and reduced-motion contexts', async () => {
    const { container } = render(<NarrationLog messages={messages} />);
    await screen.findByText('The door opens.');
    expect((await axe(container)).violations).toEqual([]);
    container
      .querySelector('.narration-log')
      ?.setAttribute('data-motion', 'reduced');
    expect((await axe(container)).violations).toEqual([]);
  });

  it('keeps the log keyboard scrollable and jump-to-latest does not move focus', () => {
    render(<NarrationLog messages={messages} />);
    const list = screen.getByRole('list', { name: /Story entries/ });
    expect(list).toHaveAttribute('tabindex', '0');
    list.focus();
    expect(list).toHaveFocus();
    expect(list.tagName).toBe('OL');
  });
});
