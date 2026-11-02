// @vitest-environment jsdom
import { Profiler } from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Battlemap, ServerMessage } from '@game/schema';
import { Game } from '../src/screens/Game.js';
import { gameStore } from '../src/state/store.js';
import { initialGameState } from '../src/state/gameStore.js';
import { http } from '../src/api.js';

const hoisted = vi.hoisted(() => ({
  send: vi.fn((): string | boolean => true),
  onMessage: undefined as ((m: ServerMessage) => void) | undefined,
  room: undefined as unknown,
  account: { id: 'acct-1' },
  privateRoundSubmission: undefined as
    | { roundId: string; actionId: string; text: string; queued: boolean }
    | undefined,
  status: 'connected' as 'connecting' | 'connected' | 'reconnecting' | 'closed',
}));
vi.mock('../src/room/useRoom.js', () => ({
  useRoom: (opts: { onMessage: (m: ServerMessage) => void }) => {
    hoisted.onMessage = opts.onMessage;
    return {
      room: hoisted.room,
      status: hoisted.status,
      send: hoisted.send,
      privateRoundSubmission: hoisted.privateRoundSubmission,
    };
  },
}));

vi.mock('../src/auth.js', () => ({
  useAuth: () => ({ account: hoisted.account }),
}));

const map: Battlemap = {
  mapId: 'game-fixture',
  w: 8,
  h: 5,
  palette: [
    {
      terrainId: 'floor',
      moveCost: 1,
      blocksMove: false,
      blocksSight: false,
      cover: 'none',
      elevation: 0,
    },
  ],
  cells: [0, 40],
  edges: [],
  features: [],
  markers: [],
  zones: [],
  diagonalRule: '5ft',
};
const HERO_ID = '00000000-0000-4000-8000-0000000000aa';
const hero = {
  id: HERO_ID,
  name: 'Aria',
  speciesId: 'species:human',
  classId: 'class:wizard',
  backgroundId: 'background:sage',
  level: 1,
  abilities: { str: 10, dex: 14, con: 14, int: 16, wis: 10, cha: 10 },
  proficiencies: { skills: [], saves: ['int', 'wis'], tools: [] },
  equipment: [],
  spellsKnown: [],
  spellsPrepared: [],
  slots: { '1': { max: 2, used: 0 } },
  hp: { current: 30, max: 30, temp: 0 },
  conditions: [],
};
const entities = [
  {
    id: HERO_ID,
    kind: 'character',
    team: 'party',
    pos: { x: 1, y: 2 },
    size: 1,
    hp: 30,
  },
  {
    id: 'ent_goblin',
    kind: 'monster',
    team: 'enemies',
    pos: { x: 5, y: 2 },
    size: 1,
    hp: 7,
    hpState: 'healthy',
  },
];
const resources = {
  [HERO_ID]: {
    action: true,
    bonusAction: true,
    reaction: true,
    movementRemaining: 30,
  },
  ent_goblin: {
    action: true,
    bonusAction: true,
    reaction: true,
    movementRemaining: 30,
  },
};
const tracker = (order: string[]) => ({
  round: 1,
  // the server rotates the list so the active entity is first
  activeEntityId: order[0] ?? null,
  initiative: order.map((entityId, i) => ({ entityId, total: 20 - i })),
  resources,
  entities,
});
let seq = 0;
const push = (type: string, payload: Record<string, unknown>) =>
  act(() => {
    hoisted.onMessage!({ seq: ++seq, type, payload } as ServerMessage);
  });

function mount(
  onRender?: () => void,
  extra: { characters?: Record<string, unknown>; entities?: unknown[] } = {},
) {
  hoisted.room = {
    gameState: {
      characters: { 'acct-1': hero, ...extra.characters },
      combatRoom: { entities: extra.entities ?? entities, map },
    },
  };
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route
          path="/"
          element={
            <Profiler id="game-opening" onRender={onRender ?? (() => {})}>
              <Game />
            </Profiler>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe('Game screen (live Room)', () => {
  beforeEach(() => {
    hoisted.privateRoundSubmission = undefined;
    hoisted.status = 'connected';
    http.fetch = async () =>
      new Response(
        JSON.stringify({ game: { recap: 'A short recap.', name: 'Fixture' } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    HTMLCanvasElement.prototype.getContext = (() =>
      new Proxy({}, { get: () => () => undefined })) as never;
    hoisted.send.mockClear();
    seq = 0;
    gameStore.setCharacter(null);
    gameStore.setCombatState(initialGameState().combat);
  });

  it('skip link focuses the action textarea; composer precedes map controls in tab order', async () => {
    const user = userEvent.setup();
    mount();
    push('CombatTracker', tracker(['ent_goblin', HERO_ID]));
    const skip = screen.getByRole('link', { name: 'Skip to your action' });
    const firstFocusable = document
      .querySelector('.game-screen')!
      .querySelector('a[href], button, textarea, input, [tabindex="0"]');
    expect(firstFocusable).toBe(skip);
    await user.click(skip);
    expect(screen.getByLabelText('Your action')).toHaveFocus();
    await user.click(screen.getByRole('link', { name: 'Skip to story' }));
    expect(document.getElementById('game-story')).toHaveFocus();
    const textarea = screen.getByLabelText('Your action');
    const endTurn = screen.getByRole('button', { name: 'End turn' });
    expect(
      textarea.compareDocumentPosition(endTurn) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('a partial DM failure shows as a dismissible alert in the page flow', async () => {
    const user = userEvent.setup();
    mount();
    push('CombatTracker', tracker(['ent_goblin', HERO_ID]));
    push('ToolRejected', {});

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(
      'The DM could not apply part of that action.',
    );
    // In the page flow after the header, not a stray thin line above it.
    const header = document.querySelector('.game-header')!;
    expect(
      header.compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(
      screen.queryByText('The DM could not apply part of that action.'),
    ).not.toBeInTheDocument();
  });

  it('never commits the opening placeholder while non-empty history is being restored', () => {
    const openingVisibilityByCommit: boolean[] = [];
    mount(() => {
      openingVisibilityByCommit.push(
        Boolean(document.querySelector('.narration-log__opening')),
      );
    });

    push('StateSync', { state: { openClarifications: {} } });
    push('NarrationHistory', {
      turns: [
        {
          turnId: 'restored-opening',
          text: 'The restored story is ready.',
          tier: 'standard',
        },
      ],
    });

    expect(openingVisibilityByCommit.length).toBeGreaterThan(1);
    expect(openingVisibilityByCommit).not.toContain(true);
    expect(
      screen.getByText('The restored story is ready.'),
    ).toBeInTheDocument();
  });

  it('shows the opening after the real synchronization fallback, then hides it when history arrives', () => {
    vi.useFakeTimers();
    try {
      mount();
      push('StateSync', { state: { openClarifications: {} } });
      expect(
        screen.queryByRole('heading', { name: 'The adventure begins' }),
      ).not.toBeInTheDocument();

      act(() => {
        vi.advanceTimersByTime(1_500);
      });
      expect(
        screen.getByRole('heading', { name: 'The adventure begins' }),
      ).toBeInTheDocument();

      push('NarrationHistory', {
        turns: [
          {
            turnId: 'late-opening',
            text: 'The late restored story is ready.',
            tier: 'standard',
          },
        ],
      });
      expect(
        screen.queryByRole('heading', { name: 'The adventure begins' }),
      ).not.toBeInTheDocument();
      expect(
        screen.getByText('The late restored story is ready.'),
      ).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('holds the opening placeholder between StateSync and restored narration history', () => {
    mount();
    push('StateSync', { state: { openClarifications: {} } });
    expect(
      screen.queryByRole('heading', { name: 'The adventure begins' }),
    ).not.toBeInTheDocument();

    push('NarrationHistory', {
      turns: [
        {
          turnId: 'restored-opening',
          text: 'The restored story is ready.',
          tier: 'standard',
        },
      ],
    });
    expect(
      screen.getByText('The restored story is ready.'),
    ).toBeInTheDocument();
  });

  it('sends flat CombatCommand payloads the server schema accepts', async () => {
    const user = userEvent.setup();
    mount();
    push('CombatTracker', tracker(['ent_goblin', HERO_ID]));
    await user.click(screen.getByRole('button', { name: 'End turn' }));
    expect(hoisted.send).toHaveBeenLastCalledWith('CombatCommand', {
      command: 'end-turn',
    });
    await user.click(
      screen.getByRole('button', { name: 'Refresh combat options' }),
    );
    expect(hoisted.send).toHaveBeenLastCalledWith('CombatCommand', {
      command: 'options',
    });
    push('CombatOptions', {
      actions: [
        {
          kind: 'attack',
          optionId: 'a',
          targetId: 'ent_goblin',
          attackId: 'staff',
        },
        { kind: 'move', optionId: 'm', destination: { x: 2, y: 2 }, cost: 5 },
      ],
    });
    await user.click(
      screen.getByRole('button', { name: 'Attack Goblin with Staff' }),
    );
    expect(hoisted.send).toHaveBeenLastCalledWith('CombatCommand', {
      command: 'attack',
      targetId: 'ent_goblin',
      attackId: 'staff',
    });
    // The label is 1-based like the keyboard announcements; the wire destination stays 0-based.
    await user.click(screen.getByRole('button', { name: /Move to 3, 3/ }));
    expect(hoisted.send).toHaveBeenLastCalledWith('CombatCommand', {
      command: 'move',
      destination: { x: 2, y: 2 },
    });
  });

  it('CombatEnded clears the combat bar, threat line and stale attacks, then Continue returns to exploration', async () => {
    const user = userEvent.setup();
    mount();
    push('CombatTracker', tracker(['ent_goblin', HERO_ID]));
    push('CombatOptions', {
      actions: [
        {
          kind: 'attack',
          optionId: 'a',
          targetId: 'ent_goblin',
          attackId: 'equipment:javelin',
        },
        { kind: 'move', optionId: 'm', destination: { x: 2, y: 2 }, cost: 5 },
      ],
    });
    expect(
      screen.getByRole('button', { name: 'Attack Goblin with Javelin' }),
    ).toBeInTheDocument();

    push('CombatEnded', { outcome: 'party-victory' });

    expect(
      within(screen.getByRole('region', { name: 'Combat result' })).getByRole(
        'status',
      ),
    ).toHaveTextContent('Victory');
    expect(
      screen.queryByRole('button', { name: 'Attack Goblin with Javelin' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /^Move to / }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'End turn' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Threats within 30 feet/),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/CombatEnded:/)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(
      screen.queryByRole('region', { name: 'Combat result' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Continue' }),
    ).not.toBeInTheDocument();
  });

  it('a room-state refresh after CombatEnded keeps the result card on screen', () => {
    mount();
    push('CombatTracker', tracker(['ent_goblin', HERO_ID]));
    push('CombatEnded', { outcome: 'party-victory' });
    // A reconnect refetches room state; the combat snapshot there carries no ended field.
    hoisted.room = {
      gameState: {
        characters: { 'acct-1': hero },
        combatRoom: {
          entities,
          map,
          combat: { round: 1, activeEntityId: null, initiative: [] },
        },
      },
    };
    push('CombatOptions', { actions: [] });

    expect(
      screen.getByRole('region', { name: 'Combat result' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('region', { name: 'Combat commands' }),
    ).not.toBeInTheDocument();
  });

  it('area aim: an aim previews its affected units and Cast sends the option ref', async () => {
    const user = userEvent.setup();
    mount();
    push('CombatTracker', tracker(['ent_goblin', HERO_ID]));
    push('CombatOptions', {
      actions: [],
      areas: [
        {
          spellId: 'spell:burning-hands',
          optionId: 'area:burning-hands:2,2:1,0',
          anchor: { x: 2, y: 2 },
          direction: { x: 1, y: 0 },
          cells: [{ x: 2, y: 2 }],
          affected: [{ id: 'ent_goblin', relation: 'enemy' }],
        },
      ],
    });
    await user.click(
      screen.getByRole('radio', {
        name: /burning hands at 3, 3, facing east; 1 affected/,
      }),
    );
    expect(screen.getByText('1 affected: Goblin (enemy).')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cast area' }));
    expect(hoisted.send).toHaveBeenLastCalledWith('CombatCommand', {
      command: 'cast',
      spellId: 'spell:burning-hands',
      slotLevel: 1,
      target: { kind: 'option', ref: 'area:burning-hands:2,2:1,0' },
    });
  });

  it('shows pending immediately on submit and clears it on the matching narration', async () => {
    const user = userEvent.setup();
    mount();
    await user.type(screen.getByLabelText('Your action'), 'I search the room.');
    await user.click(screen.getByRole('button', { name: 'Send action' }));
    expect(screen.getByText('Queued: I search the room.')).toBeInTheDocument();
    expect(hoisted.send).toHaveBeenLastCalledWith('PlayerAction', {
      text: 'I search the room.',
    });
    push('ActionQueued', { actionId: 'server-action-1' });
    push('NarrationCompleted', {
      actionId: 'server-action-1',
      turnId: 'turn-1',
      text: 'You find a key.',
    });
    expect(
      screen.queryByText('Queued: I search the room.'),
    ).not.toBeInTheDocument();
  });

  it('a turn failure for another seat leaves this seat queued and offers no retry', async () => {
    const user = userEvent.setup();
    hoisted.send.mockReturnValueOnce('mine-1');
    mount();
    await user.type(screen.getByLabelText('Your action'), 'I search the room.');
    await user.click(screen.getByRole('button', { name: 'Send action' }));
    push('ActionQueued', { actionId: 'mine-1' });
    push('Error', {
      code: 'TURN_FAILED',
      message: 'The DM could not complete that turn. You can try again.',
      actionId: 'their-action',
    });
    expect(screen.getByText('Queued: I search the room.')).toBeInTheDocument();
    expect(screen.getByLabelText('Your action')).toHaveValue('');
    expect(
      screen.queryByRole('button', { name: 'Retry this action' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(
        'The DM could not complete that turn. You can try again.',
      ),
    ).not.toBeInTheDocument();
  });

  it('a turn failure for this seat restores its text and offers Retry', async () => {
    const user = userEvent.setup();
    hoisted.send.mockReturnValueOnce('mine-1');
    mount();
    await user.type(screen.getByLabelText('Your action'), 'I search the room.');
    await user.click(screen.getByRole('button', { name: 'Send action' }));
    push('ActionQueued', { actionId: 'mine-1' });
    push('Error', {
      code: 'TURN_FAILED',
      message: 'The DM could not complete that turn. You can try again.',
      actionId: 'mine-1',
    });
    expect(
      screen.queryByText('Queued: I search the room.'),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText('Your action')).toHaveValue(
      'I search the room.',
    );
    await user.click(screen.getByRole('button', { name: 'Retry this action' }));
    expect(hoisted.send).toHaveBeenLastCalledWith('PlayerAction', {
      text: 'I search the room.',
    });
  });

  it('Retry while disconnected keeps the failed text so it can be resent later', async () => {
    const user = userEvent.setup();
    hoisted.send.mockReturnValueOnce('mine-1');
    mount();
    await user.type(screen.getByLabelText('Your action'), 'I search the room.');
    await user.click(screen.getByRole('button', { name: 'Send action' }));
    push('ActionQueued', { actionId: 'mine-1' });
    push('Error', {
      code: 'TURN_FAILED',
      message: 'The DM could not complete that turn. You can try again.',
      actionId: 'mine-1',
    });
    expect(screen.getByLabelText('Your action')).toHaveValue(
      'I search the room.',
    );

    // The socket drops before Retry: live.send refuses the resend.
    hoisted.send.mockReturnValueOnce(false);
    await user.click(screen.getByRole('button', { name: 'Retry this action' }));
    expect(
      screen.getByText(
        'Not connected, so your action was not sent. Try again.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Your action')).toHaveValue(
      'I search the room.',
    );
    expect(
      screen.getByRole('button', { name: 'Retry this action' }),
    ).toBeInTheDocument();

    // Once the socket is back, Retry sends the preserved text and clears the box.
    hoisted.send.mockReturnValueOnce('mine-2');
    await user.click(screen.getByRole('button', { name: 'Retry this action' }));
    expect(hoisted.send).toHaveBeenLastCalledWith('PlayerAction', {
      text: 'I search the room.',
    });
    expect(screen.getByLabelText('Your action')).toHaveValue('');
    expect(screen.getByText('Queued: I search the room.')).toBeInTheDocument();
  });

  it('Retry moves keyboard focus to the action box instead of dropping it to the page', async () => {
    const user = userEvent.setup();
    hoisted.send.mockReturnValueOnce('mine-1');
    mount();
    await user.type(screen.getByLabelText('Your action'), 'I search the room.');
    await user.click(screen.getByRole('button', { name: 'Send action' }));
    push('ActionQueued', { actionId: 'mine-1' });
    push('Error', {
      code: 'TURN_FAILED',
      message: 'The DM could not complete that turn. You can try again.',
      actionId: 'mine-1',
    });
    const retry = screen.getByRole('button', { name: 'Retry this action' });
    retry.focus();
    expect(retry).toHaveFocus();

    hoisted.send.mockReturnValueOnce('mine-2');
    await user.click(retry);
    // The Retry button unmounts once the failure clears; focus must land on the action box, not on body.
    expect(
      screen.queryByRole('button', { name: 'Retry this action' }),
    ).not.toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByLabelText('Your action'));
  });

  it('a round failure restores only the seat whose submission was in that round', async () => {
    const user = userEvent.setup();
    hoisted.send.mockReturnValueOnce('mine-1');
    mount();
    await user.type(screen.getByLabelText('Your action'), 'I search the room.');
    hoisted.privateRoundSubmission = {
      roundId: 'round-7',
      actionId: 'mine-1',
      text: 'I search the room.',
      queued: true,
    };
    await user.click(screen.getByRole('button', { name: 'Send action' }));
    push('Error', {
      code: 'TURN_FAILED',
      message: 'The DM could not complete that round. Try again.',
      actionId: 'round-9',
    });
    expect(screen.getByText('Queued: I search the room.')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Retry this action' }),
    ).not.toBeInTheDocument();
    // The server resolves the round (clearing the private submission) before its turn can fail.
    hoisted.privateRoundSubmission = undefined;
    push('RoundResolved', {
      roundId: 'round-7',
      closeReason: 'all-submitted',
      actions: [],
    });
    push('Error', {
      code: 'TURN_FAILED',
      message: 'The DM could not complete that round. Try again.',
      actionId: 'round-7',
    });
    expect(
      screen.queryByText('Queued: I search the room.'),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText('Your action')).toHaveValue(
      'I search the room.',
    );
    expect(
      screen.getByRole('button', { name: 'Retry this action' }),
    ).toBeInTheDocument();
    hoisted.privateRoundSubmission = undefined;
  });

  it('a round-path restriction for a seat that is not restricted shows the generic failure with Retry', async () => {
    const user = userEvent.setup();
    hoisted.send.mockReturnValueOnce('mine-1');
    mount();
    await user.type(screen.getByLabelText('Your action'), 'I search the room.');
    hoisted.privateRoundSubmission = {
      roundId: 'round-7',
      actionId: 'mine-1',
      text: 'I search the room.',
      queued: true,
    };
    await user.click(screen.getByRole('button', { name: 'Send action' }));
    // The server broadcasts the round's restriction to every seat; it names the round, not this seat's action.
    push('Error', {
      code: 'LIVE_DM_RESTRICTED',
      message: 'Live DM is not enabled for this account.',
      actionId: 'round-7',
    });
    expect(
      screen.getByText('The DM could not complete that turn.'),
    ).toBeInTheDocument();
    expect(
      screen.queryByText('Live DM is not enabled for this account.'),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText('Your action')).toHaveValue(
      'I search the room.',
    );
    await user.click(screen.getByRole('button', { name: 'Retry this action' }));
    expect(hoisted.send).toHaveBeenLastCalledWith('PlayerAction', {
      text: 'I search the room.',
    });
    hoisted.privateRoundSubmission = undefined;
  });

  it('a single-action restriction for this seat keeps the restricted copy and no Retry', async () => {
    const user = userEvent.setup();
    hoisted.send.mockReturnValueOnce('mine-1');
    mount();
    await user.type(screen.getByLabelText('Your action'), 'I search the room.');
    await user.click(screen.getByRole('button', { name: 'Send action' }));
    push('ActionQueued', { actionId: 'mine-1' });
    push('Error', {
      code: 'LIVE_DM_RESTRICTED',
      message: 'Live DM is not enabled for this account.',
      actionId: 'mine-1',
    });
    expect(
      screen.getByText('Live DM is not enabled for this account.'),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Retry this action' }),
    ).not.toBeInTheDocument();
  });

  it('shows a clarifying question only to the seat whose own action it asks about', async () => {
    const user = userEvent.setup();
    hoisted.send.mockReturnValueOnce('mine-1');
    mount();
    await user.type(
      screen.getByLabelText('Your action'),
      'I ask the innkeeper.',
    );
    await user.click(screen.getByRole('button', { name: 'Send action' }));
    push('ClarificationRequested', {
      actionId: 'their-action',
      question: 'Which door?',
    });
    expect(
      screen.queryByRole('form', { name: 'Reply to clarifying question' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('Which door?')).not.toBeInTheDocument();
    push('ClarificationRequested', {
      actionId: 'mine-1',
      question: 'Which door?',
    });
    expect(
      screen.getByRole('form', { name: 'Reply to clarifying question' }),
    ).toHaveTextContent('Which door?');
  });

  it('a state sync leaves the owner reply prompt open', async () => {
    const user = userEvent.setup();
    hoisted.send.mockReturnValueOnce('mine-1');
    mount();
    await user.type(
      screen.getByLabelText('Your action'),
      'I ask the innkeeper.',
    );
    await user.click(screen.getByRole('button', { name: 'Send action' }));
    push('ClarificationRequested', {
      actionId: 'mine-1',
      question: 'Which door?',
    });
    push('StateSync', { state: { openClarifications: {} } });
    expect(
      screen.getByRole('form', { name: 'Reply to clarifying question' }),
    ).toHaveTextContent('Which door?');
  });

  it('the owner answers the prompt, and an error for that action ends it', async () => {
    const user = userEvent.setup();
    hoisted.send.mockReturnValueOnce('mine-1');
    mount();
    await user.type(
      screen.getByLabelText('Your action'),
      'I ask the innkeeper.',
    );
    await user.click(screen.getByRole('button', { name: 'Send action' }));
    push('ClarificationRequested', {
      actionId: 'mine-1',
      question: 'Which door?',
    });
    await user.type(screen.getByLabelText('Your reply'), 'The red one.');
    await user.click(
      screen.getByRole('button', { name: 'Reply to this action' }),
    );
    expect(hoisted.send).toHaveBeenLastCalledWith('ClarificationAnswer', {
      actionId: 'mine-1',
      answer: 'The red one.',
    });
    expect(
      screen.queryByRole('form', { name: 'Reply to clarifying question' }),
    ).not.toBeInTheDocument();
    push('ClarificationRequested', {
      actionId: 'mine-1',
      question: 'Which door?',
    });
    push('Error', {
      code: 'TURN_FAILED',
      message: 'Turn failed.',
      actionId: 'mine-1',
    });
    expect(
      screen.queryByRole('form', { name: 'Reply to clarifying question' }),
    ).not.toBeInTheDocument();
  });

  it('keeps report action and rewind banner available in the live story log', async () => {
    const user = userEvent.setup();
    mount();
    push('NarrationCompleted', {
      actionId: 'server-action-1',
      turnId: 'turn-1',
      text: 'A sealed door opens.',
    });
    const report = screen.getByRole('button', { name: 'Report this message' });
    report.focus();
    await user.keyboard('{Enter}');
    expect(
      screen.getByRole('form', { name: 'Report message' }),
    ).toBeInTheDocument();
    push('TurnReverted', { revertedTurnId: 'turn-1' });
    const banner = screen.getByText(/The host rewound the last DM turn/i);
    expect(banner).toHaveAttribute('aria-live', 'polite');
    expect(banner).toHaveTextContent(/host rewound the last DM turn/i);
  });

  it('displays tool rejection neutrally without exposing internal details', () => {
    mount();
    push('ToolRejected', { turnId: 'turn-1' });
    expect(
      screen.getByText(/The DM could not apply part of that action\./),
    ).toBeInTheDocument();
  });

  it('highlights exactly the first tracker entry in the list and on the token', () => {
    mount();
    push('CombatTracker', tracker(['ent_goblin', HERO_ID]));
    const list = screen.getByRole('list', { name: 'Initiative tracker' });
    const items = within(list).getAllByRole('listitem');
    expect(items[0]).toHaveAttribute('aria-current', 'step');
    expect(items[1]).not.toHaveAttribute('aria-current');
    const tokens = within(
      screen.getByRole('list', { name: 'Combat tokens' }),
    ).getAllByRole('listitem');
    const active = tokens.filter(
      (t) => t.getAttribute('data-active') === 'true',
    );
    expect(active).toHaveLength(1);
    // Tokens show the derived display name, never the raw id.
    expect(active[0]!.textContent).toContain('Goblin');
    expect(active[0]!.textContent).not.toContain('ent_goblin');
    // order changes -> highlight follows the first entry
    push('CombatTracker', tracker([HERO_ID, 'ent_goblin']));
    const after = within(
      screen.getByRole('list', { name: 'Combat tokens' }),
    ).getAllByRole('listitem');
    expect(
      after.filter((t) => t.getAttribute('data-active') === 'true'),
    ).toHaveLength(1);
    expect(
      after.find((t) => t.getAttribute('data-active') === 'true')!.textContent,
    ).toContain('Aria');
  });

  it('shows no active token and says so while a creature hidden from this viewer acts', () => {
    mount();
    push('CombatTracker', {
      ...tracker([HERO_ID, 'ent_goblin']),
      activeEntityId: null,
    });
    const items = within(
      screen.getByRole('list', { name: 'Initiative tracker' }),
    ).getAllByRole('listitem');
    for (const item of items) {
      expect(item).not.toHaveAttribute('aria-current');
      expect(item.textContent).not.toContain('(active)');
    }
    const tokens = within(
      screen.getByRole('list', { name: 'Combat tokens' }),
    ).getAllByRole('listitem');
    expect(
      tokens.filter((t) => t.getAttribute('data-active') === 'true'),
    ).toHaveLength(0);
    expect(
      screen.getByText('An unseen creature is acting.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Active combatant:/)).toBeNull();
  });

  it('announces the battlefield once per turn in a polite live region, not per event', () => {
    mount();
    push('CombatTracker', tracker([HERO_ID, 'ent_goblin']));
    const live = screen
      .getAllByRole('status')
      .find((el) => /movement remaining/.test(el.textContent ?? ''));
    expect(live).toBeDefined();
    expect(live).toHaveAttribute('aria-live', 'polite');
    expect(live!.textContent).toMatch(
      new RegExp(
        `Aria: 30 feet movement remaining\\. Threats within 30 feet: `,
      ),
    );
    const first = live!.textContent;
    push('CombatEvents', {
      events: [{ type: 'HpChanged', entityId: 'ent_goblin', delta: -3, hp: 4 }],
    });
    expect(live!.textContent).toBe(first);
    // next turn (round change keyed identity) re-announces
    push('CombatTracker', { ...tracker(['ent_goblin', HERO_ID]), round: 2 });
    expect(
      screen
        .getAllByRole('status')
        .find((el) => /movement remaining/.test(el.textContent ?? ''))!
        .textContent,
    ).toMatch(/Goblin: /);
  });

  it('shows a max HP only for the viewer’s own character; another seat’s PC gets current HP or a status word', () => {
    const THORIN_ID = '00000000-0000-4000-8000-0000000000bb';
    const BRAN_ID = '00000000-0000-4000-8000-0000000000cc';
    // Another seat's sheet carries a real max; the viewer must not see it even though it is on the room state.
    const thorin = {
      ...hero,
      id: THORIN_ID,
      name: 'Thorin',
      hp: { current: 40, max: 50, temp: 0 },
    };
    const bran = {
      ...hero,
      id: BRAN_ID,
      name: 'Bran',
      hp: { current: 9, max: 60, temp: 0 },
    };
    const partyEntities = [
      ...entities,
      {
        id: THORIN_ID,
        kind: 'character',
        team: 'party',
        pos: { x: 2, y: 2 },
        size: 1,
        hp: 40,
      },
      {
        id: BRAN_ID,
        kind: 'character',
        team: 'party',
        pos: { x: 3, y: 2 },
        size: 1,
        hpState: 'wounded',
      },
    ];
    mount(undefined, {
      characters: { 'acct-2': thorin, 'acct-3': bran },
      entities: partyEntities,
    });
    push('CombatTracker', {
      ...tracker([HERO_ID, THORIN_ID, BRAN_ID, 'ent_goblin']),
      entities: partyEntities,
    });
    const tokenText = (name: string) =>
      within(screen.getByRole('list', { name: 'Combat tokens' }))
        .getAllByRole('listitem')
        .find((t) => t.textContent!.includes(name))!.textContent!;

    expect(tokenText('Aria')).toContain('HP 30/30');
    expect(tokenText('Thorin')).toContain('HP 40');
    expect(tokenText('Thorin')).not.toContain('50');
    expect(tokenText('Bran')).toContain('bloodied');
    expect(tokenText('Bran')).not.toContain('60');
    expect(tokenText('Bran')).not.toContain('HP 9');
  });

  it('updates the character sheet HP and slots within 1 s of the event', async () => {
    mount();
    push('CombatTracker', tracker([HERO_ID, 'ent_goblin']));
    expect(screen.getAllByText(/30/).length).toBeGreaterThan(0);
    const started = performance.now();
    push('CombatEvents', {
      events: [
        { type: 'HpChanged', entityId: HERO_ID, delta: -9, hp: 21 },
        { type: 'SlotSpent', entityId: HERO_ID, level: 1 },
      ],
    });
    const state = gameStore.getState().character!;
    expect(state.hp.current).toBe(21);
    expect(state.slots['1']!.used).toBe(1);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(
      await screen.findByText(/Hit points changed to 21 of 30/, undefined, {
        timeout: 1000,
      }),
    ).toBeInTheDocument();
  });

  it('has no pointer-only action: canvas is decorative and every control is a keyboard-operable element', async () => {
    const user = userEvent.setup();
    const { container } = mount();
    push('CombatTracker', tracker([HERO_ID, 'ent_goblin']));
    const canvas = container.querySelector('canvas')!;
    expect(canvas).toHaveAttribute('aria-hidden', 'true');
    // A click on the canvas is a shortcut into the same keyboard-reachable move preview; pointerdown and drag stay absent.
    expect(canvas.onpointerdown).toBeNull();
    expect(container.querySelector('[draggable="true"]')).toBeNull();
    // the move that a pointer could do is available from the keyboard map and as buttons
    const map = screen.getByRole('application', { name: 'Battle map' });
    expect(map).toHaveAttribute('tabindex', '0');
    map.focus();
    await user.keyboard('{Enter}');
    expect(map).toHaveAttribute('data-moving', 'true');
    for (const button of screen.getAllByRole('button')) {
      expect(button.tagName).toBe('BUTTON');
    }
  });

  it('gives a non-controlling seat a status notice only, never Accept/Decline controls', () => {
    mount();
    push('CombatTracker', tracker([HERO_ID, 'ent_goblin']));
    push('ReactionPromptOpen', {
      reactionId: 'r-open',
      reactorEntityId: 'ent_goblin',
      deadlineAt: new Date(Date.now() + 5000).toISOString(),
      timeoutMs: 5000,
    });
    expect(
      screen.getByText(/Reaction window open for Goblin/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Accept' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Decline' }),
    ).not.toBeInTheDocument();
  });

  it('gives the controlling reactor the decision dialog from ReactionPrompt', () => {
    mount();
    push('CombatTracker', tracker([HERO_ID, 'ent_goblin']));
    push('ReactionPrompt', {
      reactionId: 'r-own',
      entityId: 'ent_goblin',
      moverId: HERO_ID,
      trigger: 'opportunityAttack',
      options: ['take', 'decline'],
      defaultChoice: 'decline',
      timeoutMs: 5000,
    });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Accept' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Decline' })).toBeInTheDocument();
  });
});

describe('Game screen layout', () => {
  beforeEach(() => {
    http.fetch = async () =>
      new Response(
        JSON.stringify({ game: { recap: 'A short recap.', name: 'Fixture' } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    HTMLCanvasElement.prototype.getContext = (() =>
      new Proxy({}, { get: () => () => undefined })) as never;
    hoisted.send.mockClear();
    seq = 0;
    gameStore.setCharacter(null);
    gameStore.setCombatState(initialGameState().combat);
  });

  it('before combat: map placeholder explains how a fight starts; safety is a toolbar, panels are collapsed drawers; no nested main', async () => {
    const { container } = mount();
    expect(
      await screen.findByText(/Combat starts when a fight breaks out/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('region', { name: 'Safety controls' }),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: /X-card/ })).toBeEnabled();
    expect(screen.getByRole('region', { name: 'Narration log' })).toBeVisible();
    // The app shell owns the <main> landmark; the game screen must not add a second one.
    expect(container.querySelector('main')).toBeNull();
    for (const drawer of container.querySelectorAll('details.drawer'))
      expect(drawer).not.toHaveAttribute('open');
    expect((await axe(container)).violations).toEqual([]);
  });

  it('the safety disclosure explains the controls in player-facing words', async () => {
    mount();
    await screen.findByText(/Combat starts when a fight breaks out/);
    const about = screen.getByText('About these controls').closest('details');
    expect(about).not.toBeNull();
    expect(about).toHaveTextContent('X-card');
    expect(about).not.toHaveTextContent('No explanation is needed');
  });

  it('in combat: the tracker and the map replace the placeholder, and axe stays clean', async () => {
    const { container } = mount();
    await screen.findByText(/Combat starts when a fight breaks out/);
    await push('CombatTracker', tracker([HERO_ID, 'ent_goblin']));
    expect(
      screen.queryByText(/Combat starts when a fight breaks out/),
    ).toBeNull();
    expect(
      screen.getByRole('list', { name: 'Initiative tracker' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('application', { name: 'Battle map' }),
    ).toBeInTheDocument();
    expect((await axe(container)).violations).toEqual([]);
  });
});

describe('Game screen narrow viewport', () => {
  const stubNarrow = () => {
    const original = window.matchMedia;
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: true,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    return () => {
      window.matchMedia = original;
    };
  };

  it('starts in list-driven combat, opens the map on request, and keeps reactions operable', async () => {
    const restore = stubNarrow();
    try {
      const user = userEvent.setup();
      const { container } = mount();
      push('CombatTracker', tracker([HERO_ID, 'ent_goblin']));
      expect(container.querySelector('canvas')).toBeNull();
      expect(
        screen.getByRole('list', { name: 'Combat tokens' }),
      ).toBeInTheDocument();
      const toggle = screen.getByRole('button', { name: 'Show map' });
      expect(toggle).toHaveAttribute('aria-expanded', 'false');

      await user.click(toggle);
      expect(container.querySelector('canvas')).not.toBeNull();
      expect(screen.getByRole('button', { name: 'Hide map' })).toHaveAttribute(
        'aria-expanded',
        'true',
      );

      await user.click(screen.getByRole('button', { name: 'Hide map' }));
      expect(container.querySelector('canvas')).toBeNull();

      push('ReactionPrompt', {
        reactionId: 'r1',
        entityId: 'ent_goblin',
        moverId: HERO_ID,
        trigger: 'leaves reach',
        timeoutMs: 15000,
      });
      expect(
        await screen.findByRole('dialog', { name: 'Opportunity attack' }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: 'Decline' }),
      ).toBeInTheDocument();
    } finally {
      restore();
    }
  });
});

describe('Combat bar stays current (options, move shortcut, clarification placement)', () => {
  const trackerAt = (heroPos: { x: number; y: number }, movement: number) => ({
    round: 1,
    activeEntityId: HERO_ID,
    initiative: [HERO_ID, 'ent_goblin'].map((entityId, i) => ({
      entityId,
      total: 20 - i,
    })),
    resources: {
      ...resources,
      [HERO_ID]: { ...resources[HERO_ID], movementRemaining: movement },
    },
    entities: entities.map((entity) =>
      entity.id === HERO_ID ? { ...entity, pos: heroPos } : entity,
    ),
  });

  beforeEach(() => {
    hoisted.privateRoundSubmission = undefined;
    http.fetch = async () =>
      new Response(
        JSON.stringify({ game: { recap: 'A short recap.', name: 'Fixture' } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    HTMLCanvasElement.prototype.getContext = (() =>
      new Proxy({}, { get: () => () => undefined })) as never;
    hoisted.send.mockClear();
    seq = 0;
    gameStore.setCharacter(null);
    gameStore.setCombatState(initialGameState().combat);
  });

  it('requests combat options when this seat turn starts, with no manual refresh', () => {
    mount();
    push('CombatTracker', trackerAt({ x: 1, y: 2 }, 30));
    expect(hoisted.send).toHaveBeenCalledWith('CombatCommand', {
      command: 'options',
    });
  });

  it('names the weapon only when one target has several attacks, and lists each attack once', async () => {
    mount();
    push('CombatTracker', trackerAt({ x: 2, y: 2 }, 30));
    push('CombatOptions', {
      actions: [
        {
          kind: 'attack',
          optionId: 'a1',
          targetId: 'ent_goblin',
          attackId: 'equipment:javelin',
        },
        {
          kind: 'attack',
          optionId: 'a2',
          targetId: 'ent_goblin',
          attackId: 'equipment:shortbow',
        },
        {
          kind: 'attack',
          optionId: 'a3',
          targetId: 'ent_goblin',
          attackId: 'equipment:javelin',
        },
      ],
    });
    expect(
      screen.getByRole('button', { name: 'Attack Goblin with Javelin' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Attack Goblin with Shortbow' }),
    ).toBeInTheDocument();
    expect(
      screen.getAllByRole('button', { name: /^Attack Goblin/ }),
    ).toHaveLength(2);
  });

  it('names foes that no attack option reaches, and only once options have arrived', () => {
    mount();
    const bandit = {
      id: 'ent_bandit',
      kind: 'monster',
      team: 'enemies',
      pos: { x: 7, y: 4 },
      size: 1,
      hp: 9,
      hpState: 'healthy',
    };
    const base = trackerAt({ x: 1, y: 2 }, 30);
    push('CombatTracker', { ...base, entities: [...base.entities, bandit] });
    expect(screen.queryByText(/Not in reach/)).not.toBeInTheDocument();
    push('CombatOptions', {
      actions: [
        {
          kind: 'attack',
          optionId: 'a1',
          targetId: 'ent_goblin',
          attackId: 'staff',
        },
      ],
    });
    expect(
      screen.getByText('Not in reach of your attacks right now: Bandit.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Not in reach.*Goblin/)).not.toBeInTheDocument();
  });

  it('hides the out-of-reach hint while a refreshed options request is pending after the board changes', () => {
    mount();
    const bandit = {
      id: 'ent_bandit',
      kind: 'monster',
      team: 'enemies',
      pos: { x: 7, y: 4 },
      size: 1,
      hp: 9,
      hpState: 'healthy',
    };
    const withBandit = (pos: { x: number; y: number }) => {
      const base = trackerAt(pos, 30);
      return { ...base, entities: [...base.entities, bandit] };
    };
    push('CombatTracker', withBandit({ x: 1, y: 2 }));
    push('CombatOptions', {
      actions: [
        {
          kind: 'attack',
          optionId: 'a1',
          targetId: 'ent_goblin',
          attackId: 'staff',
        },
      ],
    });
    expect(
      screen.getByText('Not in reach of your attacks right now: Bandit.'),
    ).toBeInTheDocument();
    // The seat moved: a new options request is sent but its reply has not arrived.
    push('CombatTracker', withBandit({ x: 2, y: 2 }));
    expect(screen.queryByText(/Not in reach/)).not.toBeInTheDocument();
  });

  it('a refresh pressed while an earlier options request is pending does not tag its stale reply as current', () => {
    mount();
    const bandit = {
      id: 'ent_bandit',
      kind: 'monster',
      team: 'enemies',
      pos: { x: 7, y: 4 },
      size: 1,
      hp: 9,
      hpState: 'healthy',
    };
    const withBandit = (pos: { x: number; y: number }) => {
      const base = trackerAt(pos, 30);
      return { ...base, entities: [...base.entities, bandit] };
    };
    push('CombatTracker', withBandit({ x: 1, y: 2 }));
    push('CombatOptions', {
      actions: [
        {
          kind: 'attack',
          optionId: 'a1',
          targetId: 'ent_goblin',
          attackId: 'staff',
        },
      ],
    });
    // Request R1 is sent for this state and stays pending.
    push('CombatTracker', withBandit({ x: 2, y: 2 }));
    // The seat moves again while R1 is pending, then the button is pressed.
    push('CombatTracker', withBandit({ x: 3, y: 2 }));
    fireEvent.click(
      screen.getByRole('button', { name: 'Refresh combat options' }),
    );
    // R1 answers the earlier state. It must not be shown as the current answer.
    push('CombatOptions', {
      actions: [
        {
          kind: 'attack',
          optionId: 'a1',
          targetId: 'ent_goblin',
          attackId: 'staff',
        },
      ],
    });
    expect(screen.queryByText(/Not in reach/)).not.toBeInTheDocument();
  });

  it('a foe that is down, with no numeric HP on the wire, is never named as out of reach', () => {
    mount();
    const downed = {
      id: 'ent_bandit',
      kind: 'monster',
      team: 'enemies',
      pos: { x: 7, y: 4 },
      size: 1,
      hpState: 'down',
    };
    const base = trackerAt({ x: 1, y: 2 }, 30);
    push('CombatTracker', { ...base, entities: [...base.entities, downed] });
    push('CombatOptions', {
      actions: [
        {
          kind: 'attack',
          optionId: 'a1',
          targetId: 'ent_goblin',
          attackId: 'staff',
        },
      ],
    });
    expect(screen.queryByText(/Not in reach/)).not.toBeInTheDocument();
  });

  it('a rejected attack gets neutral copy beside the attack buttons, and the next attack clears it', async () => {
    const user = userEvent.setup();
    mount();
    push('CombatTracker', trackerAt({ x: 2, y: 2 }, 30));
    push('CombatOptions', {
      actions: [
        {
          kind: 'attack',
          optionId: 'a1',
          targetId: 'ent_goblin',
          attackId: 'staff',
        },
      ],
    });
    hoisted.send.mockReturnValueOnce('atk-1');
    await user.click(
      screen.getByRole('button', { name: 'Attack Goblin with Staff' }),
    );
    push('Error', {
      code: 'COMMAND_REJECTED',
      message: 'That target is not a legal attack.',
      actionId: 'atk-1',
    });
    const feedback = screen.getByRole('alert');
    expect(feedback).toHaveClass('combat-attack-feedback');
    expect(feedback).toHaveTextContent(
      'That attack could not be made. Try another target or action.',
    );
    expect(
      screen.queryByText('That target is not a legal attack.'),
    ).not.toBeInTheDocument();
    hoisted.send.mockReturnValueOnce('atk-2');
    await user.click(
      screen.getByRole('button', { name: 'Attack Goblin with Staff' }),
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('gives every attack rejection the same neutral copy, whatever the server wording, and never blames range, cover or reach', async () => {
    const user = userEvent.setup();
    mount();
    push('CombatTracker', trackerAt({ x: 2, y: 2 }, 30));
    push('CombatOptions', {
      actions: [
        {
          kind: 'attack',
          optionId: 'a1',
          targetId: 'ent_goblin',
          attackId: 'staff',
        },
      ],
    });
    const serverWording = [
      'That target is not a legal attack.',
      'That attack is not currently available.',
    ];
    for (const [index, message] of serverWording.entries()) {
      const actionId = `atk-generic-${index}`;
      hoisted.send.mockReturnValueOnce(actionId);
      await user.click(
        screen.getByRole('button', { name: 'Attack Goblin with Staff' }),
      );
      push('Error', { code: 'COMMAND_REJECTED', message, actionId });
      const feedback = screen.getByRole('alert');
      expect(feedback).toHaveTextContent(
        'That attack could not be made. Try another target or action.',
      );
      expect(feedback.textContent).not.toMatch(/range|cover|reach/i);
      expect(screen.queryByText(message)).not.toBeInTheDocument();
    }
  });

  it('ignores a rejection for an earlier attack that arrives after a newer attack was sent', async () => {
    const user = userEvent.setup();
    mount();
    push('CombatTracker', trackerAt({ x: 2, y: 2 }, 30));
    push('CombatOptions', {
      actions: [
        {
          kind: 'attack',
          optionId: 'a1',
          targetId: 'ent_goblin',
          attackId: 'staff',
        },
      ],
    });
    hoisted.send.mockReturnValueOnce('atk-old');
    await user.click(
      screen.getByRole('button', { name: 'Attack Goblin with Staff' }),
    );
    hoisted.send.mockReturnValueOnce('atk-new');
    await user.click(
      screen.getByRole('button', { name: 'Attack Goblin with Staff' }),
    );
    // The first attack's rejection lands late: it must not show against the second attack.
    push('Error', {
      code: 'COMMAND_REJECTED',
      message: 'That target is not a legal attack.',
      actionId: 'atk-old',
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(
      screen.queryByText('That target is not a legal attack.'),
    ).not.toBeInTheDocument();
    // The newest attack's own rejection still explains itself.
    push('Error', {
      code: 'COMMAND_REJECTED',
      message: 'That target is not a legal attack.',
      actionId: 'atk-new',
    });
    expect(screen.getByRole('alert')).toHaveTextContent(
      'That attack could not be made. Try another target or action.',
    );
  });

  it('a late rejection after a remount still explains the newest attack, and never falls through to the header error', async () => {
    const user = userEvent.setup();
    const first = mount();
    push('CombatTracker', trackerAt({ x: 2, y: 2 }, 30));
    push('CombatOptions', {
      actions: [
        {
          kind: 'attack',
          optionId: 'a1',
          targetId: 'ent_goblin',
          attackId: 'staff',
        },
      ],
    });
    hoisted.send.mockReturnValueOnce('atk-remount');
    await user.click(
      screen.getByRole('button', { name: 'Attack Goblin with Staff' }),
    );
    first.unmount();
    mount();
    push('CombatTracker', trackerAt({ x: 2, y: 2 }, 30));
    push('Error', {
      code: 'COMMAND_REJECTED',
      message: 'That target is not a legal attack.',
      actionId: 'atk-remount',
    });
    expect(
      screen.queryByText('That target is not a legal attack.'),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'That attack could not be made. Try another target or action.',
    );
  });

  it('after a remount, a late rejection for an older attack stays silent', async () => {
    const user = userEvent.setup();
    const first = mount();
    push('CombatTracker', trackerAt({ x: 2, y: 2 }, 30));
    push('CombatOptions', {
      actions: [
        {
          kind: 'attack',
          optionId: 'a1',
          targetId: 'ent_goblin',
          attackId: 'staff',
        },
      ],
    });
    hoisted.send.mockReturnValueOnce('atk-before');
    await user.click(
      screen.getByRole('button', { name: 'Attack Goblin with Staff' }),
    );
    hoisted.send.mockReturnValueOnce('atk-after');
    await user.click(
      screen.getByRole('button', { name: 'Attack Goblin with Staff' }),
    );
    first.unmount();
    mount();
    push('CombatTracker', trackerAt({ x: 2, y: 2 }, 30));
    push('Error', {
      code: 'COMMAND_REJECTED',
      message: 'That target is not a legal attack.',
      actionId: 'atk-before',
    });
    expect(
      screen.queryByText('That target is not a legal attack.'),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('leaving the game forgets its attacks, so a fresh visit does not swallow an old rejection', () => {
    vi.useFakeTimers();
    try {
      const first = mount();
      push('CombatTracker', trackerAt({ x: 2, y: 2 }, 30));
      push('CombatOptions', {
        actions: [
          {
            kind: 'attack',
            optionId: 'a1',
            targetId: 'ent_goblin',
            attackId: 'staff',
          },
        ],
      });
      hoisted.send.mockReturnValueOnce('atk-left');
      fireEvent.click(
        screen.getByRole('button', { name: 'Attack Goblin with Staff' }),
      );
      first.unmount();
      act(() => {
        vi.advanceTimersByTime(1_000);
      });
      mount();
      push('CombatTracker', trackerAt({ x: 2, y: 2 }, 30));
      push('Error', {
        code: 'COMMAND_REJECTED',
        message: 'That target is not a legal attack.',
        actionId: 'atk-left',
      });
      // Nothing remembers the old attack, so the rejection reaches the header error as before.
      expect(
        screen.getByText('That target is not a legal attack.'),
      ).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a late rejection for the newest attack, after the 5 s send window, keeps neutral copy and never shows server wording', () => {
    vi.useFakeTimers();
    try {
      mount();
      push('CombatTracker', trackerAt({ x: 2, y: 2 }, 30));
      push('CombatOptions', {
        actions: [
          {
            kind: 'attack',
            optionId: 'a1',
            targetId: 'ent_goblin',
            attackId: 'staff',
          },
        ],
      });
      hoisted.send.mockReturnValueOnce('atk-late');
      fireEvent.click(
        screen.getByRole('button', { name: 'Attack Goblin with Staff' }),
      );
      act(() => {
        vi.advanceTimersByTime(6_000);
      });
      push('Error', {
        code: 'COMMAND_REJECTED',
        message: 'That target is not a legal attack.',
        actionId: 'atk-late',
      });
      expect(screen.getByRole('alert')).toHaveTextContent(
        'That attack could not be made. Try another target or action.',
      );
      expect(
        screen.queryByText('That target is not a legal attack.'),
      ).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a late rejection for an attack superseded after the 5 s window is swallowed, not sent to the header', () => {
    vi.useFakeTimers();
    try {
      mount();
      push('CombatTracker', trackerAt({ x: 2, y: 2 }, 30));
      push('CombatOptions', {
        actions: [
          {
            kind: 'attack',
            optionId: 'a1',
            targetId: 'ent_goblin',
            attackId: 'staff',
          },
        ],
      });
      hoisted.send.mockReturnValueOnce('atk-old');
      fireEvent.click(
        screen.getByRole('button', { name: 'Attack Goblin with Staff' }),
      );
      act(() => {
        vi.advanceTimersByTime(6_000);
      });
      hoisted.send.mockReturnValueOnce('atk-new');
      fireEvent.click(
        screen.getByRole('button', { name: 'Attack Goblin with Staff' }),
      );
      push('Error', {
        code: 'COMMAND_REJECTED',
        message: 'That target is not a legal attack.',
        actionId: 'atk-old',
      });
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(
        screen.queryByText('That target is not a legal attack.'),
      ).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a rejection for a command that was never an attack still reaches the page header', () => {
    mount();
    push('Error', {
      code: 'COMMAND_REJECTED',
      message: 'That move is blocked by a wall.',
      actionId: 'move-1',
    });
    expect(
      screen.getByText('That move is blocked by a wall.'),
    ).toBeInTheDocument();
  });

  it('combat log, tracker and tokens never print a UUID entity id, even when the entity is unnamed', () => {
    const uuid = '3f2a9c1e-7b4d-4e8a-9f10-2c5d6e7f8a9b';
    const uuidMonster = {
      id: `ent_${uuid}`,
      kind: 'monster',
      team: 'enemies',
      pos: { x: 6, y: 2 },
      size: 1,
      hp: 9,
      hpState: 'healthy',
    };
    mount();
    push('CombatTracker', {
      ...tracker([HERO_ID, uuidMonster.id]),
      entities: [...entities, uuidMonster],
      resources: { ...resources, [uuidMonster.id]: resources.ent_goblin },
    });
    push('CombatEvents', {
      events: [
        { type: 'HpChanged', entityId: uuidMonster.id, delta: -3, hp: 6 },
      ],
    });
    const fragment = uuid.slice(0, 8);
    const labels = Array.from(document.querySelectorAll('[aria-label]')).map(
      (el) => el.getAttribute('aria-label') ?? '',
    );
    expect(document.body.textContent).not.toContain(fragment);
    expect(labels.join(' ')).not.toContain(fragment);
    expect(document.body.textContent).toContain('Combatant');
  });

  it('refetches options after the seat moves, so Attack appears once the target is in reach', () => {
    mount();
    push('CombatTracker', trackerAt({ x: 1, y: 2 }, 30));
    push('CombatOptions', {
      actions: [
        {
          kind: 'move',
          optionId: 'm1',
          destination: { x: 2, y: 2 },
          cost: 5,
        },
      ],
    });
    expect(
      screen.queryByRole('button', { name: 'Attack Goblin with Staff' }),
    ).not.toBeInTheDocument();

    hoisted.send.mockClear();
    push('CombatTracker', trackerAt({ x: 4, y: 2 }, 25));
    expect(hoisted.send).toHaveBeenCalledWith('CombatCommand', {
      command: 'options',
    });
    push('CombatOptions', {
      actions: [
        {
          kind: 'attack',
          optionId: 'a1',
          targetId: 'ent_goblin',
          attackId: 'staff',
        },
      ],
    });
    expect(
      screen.getByRole('button', { name: 'Attack Goblin with Staff' }),
    ).toBeInTheDocument();
  });

  it('drops the options list when the turn passes to someone else', () => {
    mount();
    push('CombatTracker', trackerAt({ x: 1, y: 2 }, 30));
    push('CombatOptions', {
      actions: [
        {
          kind: 'attack',
          optionId: 'a1',
          targetId: 'ent_goblin',
          attackId: 'staff',
        },
      ],
    });
    push('CombatTracker', {
      ...trackerAt({ x: 1, y: 2 }, 0),
      activeEntityId: 'ent_goblin',
    });
    expect(
      screen.queryByRole('button', { name: 'Attack Goblin with Staff' }),
    ).not.toBeInTheDocument();
  });

  it('offers Move toward a target that moves the seat to the reachable cell nearest it', async () => {
    const user = userEvent.setup();
    mount();
    push('CombatTracker', trackerAt({ x: 1, y: 2 }, 30));
    push('CombatOptions', {
      actions: [
        { kind: 'move', optionId: 'm1', destination: { x: 2, y: 2 }, cost: 5 },
        { kind: 'move', optionId: 'm2', destination: { x: 3, y: 2 }, cost: 10 },
        { kind: 'move', optionId: 'm3', destination: { x: 4, y: 2 }, cost: 15 },
        { kind: 'move', optionId: 'm4', destination: { x: 1, y: 3 }, cost: 5 },
      ],
    });
    await user.click(
      screen.getByRole('button', { name: 'Move toward Goblin' }),
    );
    expect(hoisted.send).toHaveBeenLastCalledWith('CombatCommand', {
      command: 'move',
      destination: { x: 4, y: 2 },
    });
  });

  it('a clarifying question sits inline in the story, outside the sticky composer and the combat bar', async () => {
    const user = userEvent.setup();
    mount();
    push('CombatTracker', trackerAt({ x: 1, y: 2 }, 30));
    hoisted.send.mockReturnValueOnce('mine-1');
    await user.type(
      screen.getByLabelText('Your action'),
      'I ask the innkeeper.',
    );
    await user.click(screen.getByRole('button', { name: 'Send action' }));
    push('ClarificationRequested', {
      actionId: 'mine-1',
      question: 'Which door?',
    });
    const form = screen.getByRole('form', {
      name: 'Reply to clarifying question',
    });
    expect(form.closest('.game-area--dock')).toBeNull();
    expect(form.closest('.game-area--story')).not.toBeNull();
    expect(form.closest('details')).not.toBeNull();
    // Keyboard order: the reply comes before the composer, and the combat bar follows it.
    const composer = screen.getByLabelText('Your action');
    expect(
      form.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    const endTurn = screen.getByRole('button', { name: 'End turn' });
    expect(
      form.compareDocumentPosition(endTurn) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});

describe('Game screen background requests and cast level', () => {
  const trackerAt = (heroPos: { x: number; y: number }, movement: number) => ({
    round: 1,
    activeEntityId: HERO_ID,
    initiative: [HERO_ID, 'ent_goblin'].map((entityId, i) => ({
      entityId,
      total: 20 - i,
    })),
    resources: {
      ...resources,
      [HERO_ID]: { ...resources[HERO_ID], movementRemaining: movement },
    },
    entities: entities.map((entity) =>
      entity.id === HERO_ID ? { ...entity, pos: heroPos } : entity,
    ),
  });
  const sendCalls = () => hoisted.send.mock.calls as unknown[][];
  const callsOf = (type: string) =>
    sendCalls().filter(([sent]) => sent === type);
  const optionsCalls = () =>
    sendCalls().filter(
      ([sent, payload]) =>
        sent === 'CombatCommand' &&
        (payload as { command?: string } | undefined)?.command === 'options',
    );

  beforeEach(() => {
    hoisted.privateRoundSubmission = undefined;
    http.fetch = async () =>
      new Response(
        JSON.stringify({ game: { recap: 'A short recap.', name: 'Fixture' } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    HTMLCanvasElement.prototype.getContext = (() =>
      new Proxy({}, { get: () => () => undefined })) as never;
    hoisted.send.mockReset();
    hoisted.send.mockImplementation((): string | boolean => true);
    seq = 0;
    gameStore.setCharacter(null);
    gameStore.setCombatState(initialGameState().combat);
  });

  it('asks for chat history once while a request is outstanding, however many syncs arrive', () => {
    mount();
    push('StateSync', { state: {} });
    push('StateSync', { state: {} });
    push('StateSync', { state: {} });
    expect(callsOf('ChatHistoryRequest')).toHaveLength(1);
  });

  it('asks again on the next sync once the history reply has landed', () => {
    mount();
    push('StateSync', { state: {} });
    push('ChatHistory', { messages: [] });
    push('StateSync', { state: {} });
    expect(callsOf('ChatHistoryRequest')).toHaveLength(2);
  });

  it('a refused background history read shows no room error and frees the next sync to ask again', () => {
    mount();
    push('StateSync', { state: {} });
    push('Error', { code: 'RATE_LIMITED', message: 'Too many messages.' });
    expect(screen.queryByText('Too many messages.')).not.toBeInTheDocument();
    push('StateSync', { state: {} });
    expect(callsOf('ChatHistoryRequest')).toHaveLength(2);
  });

  it('a rate-limited player action still shows its error', async () => {
    mount();
    push('Error', {
      code: 'RATE_LIMITED',
      message: 'Too many requests. Try again later.',
      actionId: 'act-1',
    });
    expect(
      await screen.findByText('Too many requests. Try again later.'),
    ).toBeInTheDocument();
  });

  it('holds one options request in flight, and asks once more when the board changes during it', () => {
    mount();
    push('CombatTracker', trackerAt({ x: 1, y: 2 }, 30));
    expect(optionsCalls()).toHaveLength(1);
    push('CombatTracker', trackerAt({ x: 4, y: 2 }, 25));
    expect(optionsCalls()).toHaveLength(1);
    push('CombatOptions', { actions: [] });
    expect(optionsCalls()).toHaveLength(2);
    push('CombatOptions', { actions: [] });
    expect(optionsCalls()).toHaveLength(2);
  });

  it('a refused options request frees the guard so the next board change asks again', () => {
    mount();
    hoisted.send.mockReturnValueOnce('opt-1');
    push('CombatTracker', trackerAt({ x: 1, y: 2 }, 30));
    push('Error', {
      code: 'COMMAND_REJECTED',
      message: 'Not your turn.',
      actionId: 'opt-1',
    });
    push('CombatTracker', trackerAt({ x: 4, y: 2 }, 25));
    expect(optionsCalls()).toHaveLength(2);
  });

  it('a board change during a refused options request still gets its refetch', () => {
    mount();
    hoisted.send.mockReturnValueOnce('opt-1');
    push('CombatTracker', trackerAt({ x: 1, y: 2 }, 30));
    push('CombatTracker', trackerAt({ x: 4, y: 2 }, 25));
    expect(optionsCalls()).toHaveLength(1);
    push('Error', {
      code: 'COMMAND_REJECTED',
      message: 'Not your turn.',
      actionId: 'opt-1',
    });
    expect(optionsCalls()).toHaveLength(2);
  });

  it('area aim casts at the slot level the seat picks, not always level 1', async () => {
    const user = userEvent.setup();
    mount(undefined, {
      characters: {
        'acct-1': {
          ...hero,
          slots: { '1': { max: 2, used: 0 }, '2': { max: 1, used: 0 } },
        },
      },
    });
    push('CombatTracker', trackerAt({ x: 1, y: 2 }, 30));
    push('CombatOptions', {
      actions: [],
      areas: [
        {
          spellId: 'spell:thunderwave',
          optionId: 'area:thunderwave:2,2:1,0',
          anchor: { x: 2, y: 2 },
          direction: { x: 1, y: 0 },
          cells: [{ x: 2, y: 2 }],
          affected: [{ id: 'ent_goblin', relation: 'enemy' }],
        },
      ],
    });
    await user.selectOptions(screen.getByLabelText('Spell slot'), '2');
    await user.click(
      screen.getByRole('radio', { name: /facing east; 1 affected/ }),
    );
    await user.click(screen.getByRole('button', { name: 'Cast area' }));
    expect(hoisted.send).toHaveBeenLastCalledWith('CombatCommand', {
      command: 'cast',
      spellId: 'spell:thunderwave',
      slotLevel: 2,
      target: { kind: 'option', ref: 'area:thunderwave:2,2:1,0' },
    });
  });

  it('a lasting connection loss mid-combat shows the server-unavailable notice', async () => {
    hoisted.status = 'reconnecting';
    mount();
    push('CombatTracker', tracker(['ent_goblin', HERO_ID]));
    expect(
      await screen.findByText(/the server is unavailable/i, undefined, {
        timeout: 3000,
      }),
    ).toHaveTextContent(/combat is paused/i);
  });

  it('no combat means the general connection notice, not the combat one', async () => {
    hoisted.status = 'reconnecting';
    mount();
    expect(
      await screen.findByText(/connection to the table lost/i, undefined, {
        timeout: 3000,
      }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/the server is unavailable/i)).toBeNull();
  });
});
